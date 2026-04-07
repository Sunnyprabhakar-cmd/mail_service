import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

export const EMAIL_QUEUE_NAME = "email-queue";

export const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000
    },
    removeOnComplete: 1000,
    removeOnFail: 5000
  }
});

export async function enqueueCampaignRecipients(recipients, chunkSize = 2000) {
  if (!recipients.length) {
    return;
  }

  // Enqueue in chunks to avoid huge Redis payloads for very large campaigns.
  for (let offset = 0; offset < recipients.length; offset += chunkSize) {
    const chunk = recipients.slice(offset, offset + chunkSize);
    const jobs = chunk.map((recipient) => ({
      name: `recipient-${recipient.id}`,
      data: {
        recipientId: recipient.id,
        campaignId: recipient.campaign_id
      },
      opts: {
        jobId: `campaign:${recipient.campaign_id}:recipient:${recipient.id}`
      }
    }));

    await emailQueue.addBulk(jobs);
  }
}
