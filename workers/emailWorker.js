import { Worker } from "bullmq";
import { EMAIL_QUEUE_NAME } from "../queue/emailQueue.js";
import { redisConnection } from "../queue/redis.js";
import { env } from "../config/env.js";
import {
	getRecipientWithCampaign,
	markRecipientAsFailed,
	markRecipientAsSent,
	updateCampaignStatusIfComplete
} from "../db/queries.js";
import { personalizeTemplate } from "../services/templateService.js";
import { sendMailgunEmail } from "../services/mailgunService.js";
import { logger } from "../services/logger.js";

const worker = new Worker(
	EMAIL_QUEUE_NAME,
	async (job) => {
		const { recipientId, campaignId } = job.data;
		const record = await getRecipientWithCampaign(recipientId, campaignId);

		if (!record) {
			throw new Error(`Recipient ${recipientId} not found for campaign ${campaignId}`);
		}

		// Replace template placeholders with recipient-specific attributes.
		const html = personalizeTemplate(record.template, {
			name: record.name || "",
			company: record.company || "",
			email: record.email
		});

		try {
			await sendMailgunEmail({
				to: record.email,
				subject: record.subject,
				html
			});

			await markRecipientAsSent(record.recipient_id);
			await updateCampaignStatusIfComplete(record.campaign_id);

			logger.info("Email sent", {
				recipientId: record.recipient_id,
				campaignId: record.campaign_id,
				email: record.email
			});

			return { success: true };
		} catch (error) {
			const errorMessage = error.response?.data?.message || error.message;

			await markRecipientAsFailed(record.recipient_id, errorMessage);
			logger.error("Email send failed", {
				recipientId: record.recipient_id,
				campaignId: record.campaign_id,
				error: errorMessage
			});

			throw error;
		}
	},
	{
		connection: redisConnection,
		concurrency: env.emailWorkerConcurrency,
		// Global limiter is env-configurable for provider and infra constraints.
		limiter: {
			max: env.emailRateLimitMax,
			duration: env.emailRateLimitDurationMs
		}
	}
);

worker.on("completed", (job) => {
	logger.info("Job completed", { jobId: job.id });
});

worker.on("failed", (job, error) => {
	logger.error("Job failed", {
		jobId: job?.id,
		attemptsMade: job?.attemptsMade,
		error: error.message
	});
});

process.on("SIGINT", async () => {
	logger.warn("Gracefully shutting down worker");
	await worker.close();
	await redisConnection.quit();
	process.exit(0);
});
