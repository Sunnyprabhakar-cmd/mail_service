import { Readable } from "stream";
import csvParser from "csv-parser";
import { batchInsertRecipients, setCampaignImportStatus } from "../db/queries.js";

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;

function normalizeRecipient(row) {
  return {
    email: String(row.email || "").trim(),
    name: String(row.name || "").trim(),
    company: String(row.company || "").trim()
  };
}

async function flushBatch(campaignId, batch, batchSize) {
  if (!batch.length) {
    return 0;
  }

  const recipients = batch.splice(0, batch.length);
  return batchInsertRecipients(campaignId, recipients, batchSize);
}

export function parseCsvStream(readableStream) {
  return new Promise((resolve, reject) => {
    const rows = [];

    readableStream
      .pipe(csvParser())
      .on("data", (row) => {
        rows.push({
          email: (row.email || "").trim(),
          name: (row.name || "").trim(),
          company: (row.company || "").trim()
        });
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

export function validateRecipients(rows) {
  const invalid = [];
  const valid = [];

  rows.forEach((row, index) => {
    if (!row.email || !/^\S+@\S+\.\S+$/.test(row.email)) {
      invalid.push({ index, email: row.email });
      return;
    }

    valid.push(row);
  });

  return { valid, invalid };
}

export async function ingestRecipientsFromCsvBuffer({ campaignId, csvBuffer, batchSize = 1000 }) {
  await setCampaignImportStatus(campaignId, "processing", 0, 0, null);

  return new Promise((resolve, reject) => {
    const stream = Readable.from(csvBuffer);
    const parser = stream.pipe(csvParser());
    const batch = [];
    let insertedCount = 0;
    let invalidCount = 0;
    let settled = false;

    const finishSuccess = async () => {
      if (settled) {
        return;
      }

      settled = true;
      insertedCount += await flushBatch(campaignId, batch, batchSize);
      await setCampaignImportStatus(campaignId, "completed", insertedCount, invalidCount, null);
      resolve({ insertedCount, invalidCount });
    };

    parser.on("data", (row) => {
      parser.pause();

      Promise.resolve()
        .then(async () => {
          const recipient = normalizeRecipient(row);

          if (!recipient.email || !EMAIL_REGEX.test(recipient.email)) {
            invalidCount += 1;
            return;
          }

          batch.push(recipient);

          if (batch.length >= batchSize) {
            insertedCount += await flushBatch(campaignId, batch, batchSize);
          }
        })
        .then(() => parser.resume())
        .catch(async (error) => {
          if (!settled) {
            settled = true;
            parser.destroy(error);
            await setCampaignImportStatus(campaignId, "failed", insertedCount, invalidCount, error.message).catch(() => {});
            reject(error);
          }
        });
    });

    parser.on("end", () => {
      finishSuccess().catch(async (error) => {
        if (!settled) {
          settled = true;
          await setCampaignImportStatus(campaignId, "failed", insertedCount, invalidCount, error.message).catch(() => {});
          reject(error);
        }
      });
    });

    parser.on("error", async (error) => {
      if (!settled) {
        settled = true;
        await setCampaignImportStatus(campaignId, "failed", insertedCount, invalidCount, error.message).catch(() => {});
        reject(error);
      }
    });
  });
}
