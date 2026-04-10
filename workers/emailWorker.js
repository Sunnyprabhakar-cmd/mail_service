import { Worker } from "bullmq";
import http from "node:http";
import { EMAIL_QUEUE_NAME } from "../queue/emailQueue.js";
import { redisConnection } from "../queue/redis.js";
import { env } from "../config/env.js";
import {
  appendCampaignEvent,
	getCampaignAssets,
	getCampaignAttachments,
	getRecipientWithCampaign,
	markRecipientAsFailed,
	markRecipientAsSent,
	updateCampaignStatusIfComplete,
	upsertRecipientMessageMapping
} from "../db/queries.js";
import { personalizeTemplate } from "../services/templateService.js";
import { sendMailgunEmail } from "../services/mailgunService.js";
import { logger } from "../services/logger.js";
import { startWorkerHeartbeat } from "../services/workerHeartbeat.js";

const workerHttpPort = Number(process.env.WORKER_HTTP_PORT || process.env.PORT || 8081);

const workerHealthServer = http.createServer((req, res) => {
	if (req.method === "GET" && req.url === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok" }));
		return;
	}

	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("Not found");
});

workerHealthServer.listen(workerHttpPort, "0.0.0.0", () => {
	logger.info("Worker health server listening", { port: workerHttpPort });
});

const stopHeartbeat = startWorkerHeartbeat(redisConnection, {
	source: env.runWorkerInApi ? "embedded" : "worker",
	logger
});

function fallbackNameFromEmail(email) {
	const local = String(email || "").split("@")[0] || "";
	if (!local) {
		return "";
	}
	return local
		.replace(/[._-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractMailgunMessageId(payload) {
	const raw = String(payload?.id || payload?.messageId || "").trim();
	if (!raw) {
		return "";
	}
	return raw.replace(/^<|>$/g, "");
}

const worker = new Worker(
	EMAIL_QUEUE_NAME,
	async (job) => {
		const { recipientId, campaignId } = job.data;
		const record = await getRecipientWithCampaign(recipientId, campaignId);

		if (!record) {
			throw new Error(`Recipient ${recipientId} not found for campaign ${campaignId}`);
		}

		const recipientName = record.name || fallbackNameFromEmail(record.email);

		// Replace template placeholders with recipient-specific attributes.
		const variables = {
			name: recipientName,
			company: record.company || "",
			email: record.email
		};

		const html = personalizeTemplate(record.template, variables);
		const subject = personalizeTemplate(record.subject, variables);
		const inlineAssets = await getCampaignAssets(record.campaign_id);
		const attachments = await getCampaignAttachments(record.campaign_id);

		try {
			const mailgunResult = await sendMailgunEmail({
				to: record.email,
				subject,
				html,
				replyTo: record.reply_to_email,
				campaignId: record.campaign_id,
				inlineAssets,
				attachments
			});

			const messageId = extractMailgunMessageId(mailgunResult);
			if (messageId) {
				await upsertRecipientMessageMapping({
					campaignId: record.campaign_id,
					recipientId: record.recipient_id,
					recipientEmail: record.email,
					messageId
				});
			}

			await markRecipientAsSent(record.recipient_id);
			await appendCampaignEvent(record.campaign_id, record.email, "delivered", {
				_source: "mailgun-worker"
			});
			await updateCampaignStatusIfComplete(record.campaign_id);

			logger.info("Email sent", {
				recipientId: record.recipient_id,
				campaignId: record.campaign_id,
				email: record.email
			});

			return { success: true };
		} catch (error) {
			const errorMessage = error?.message || error?.response?.data?.message || String(error);
			const errorStatus = error?.response?.status;

			await markRecipientAsFailed(record.recipient_id, errorMessage);
			await appendCampaignEvent(record.campaign_id, record.email, "failed", {
				_source: "mailgun-worker",
				error: errorMessage
			});
			logger.error("Email send failed", {
				recipientId: record.recipient_id,
				campaignId: record.campaign_id,
				status: errorStatus,
				response: error?.response?.data,
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
	stopHeartbeat();
	await new Promise((resolve) => workerHealthServer.close(() => resolve(undefined)));
	await worker.close();
	await redisConnection.quit();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	logger.warn("Gracefully shutting down worker");
	stopHeartbeat();
	await new Promise((resolve) => workerHealthServer.close(() => resolve(undefined)));
	await worker.close();
	await redisConnection.quit();
	process.exit(0);
});
