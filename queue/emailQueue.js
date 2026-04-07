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

function isDuplicateJobError(error) {
  const message = String(error?.message || "");
  return /already exists|already waiting|job .* exists/i.test(message);
}

export async function enqueueCampaignRecipients(recipients, chunkSize = 2000) {
  if (!recipients.length) {
    return { queued: 0, duplicates: 0 };
  }

  let queued = 0;
  let duplicates = 0;

  // Enqueue in chunks to avoid huge Redis payloads for very large campaigns.
  for (let offset = 0; offset < recipients.length; offset += chunkSize) {
    const chunk = recipients.slice(offset, offset + chunkSize);
    for (const recipient of chunk) {
      try {
        await emailQueue.add(
          `recipient-${recipient.id}`,
          {
            recipientId: recipient.id,
            campaignId: recipient.campaign_id
          },
          {
            jobId: `campaign:${recipient.campaign_id}:recipient:${recipient.id}`
          }
        );
        queued += 1;
      } catch (error) {
        if (isDuplicateJobError(error)) {
          duplicates += 1;
          continue;
        }
        throw error;
      }
    }
  }

  return { queued, duplicates };
}
