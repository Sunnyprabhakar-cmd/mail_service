import {
  createCampaign,
  listCampaigns,
  listCampaignEvents,
  getCampaignById,
  getCampaignAssets,
  getCampaignAttachments,
  getCampaignStatusCounts,
  getPendingRecipientsByCampaign,
  replaceCampaignAttachments,
  upsertCampaignAssets,
  updateCampaignStatusIfComplete,
  upsertRecipientMessageMapping
} from "../db/queries.js";
import { randomUUID } from "node:crypto";
import { redisConnection } from "../queue/redis.js";
import { enqueueCampaignRecipients } from "../queue/emailQueue.js";
import { ingestRecipientsFromCsvBuffer } from "../services/campaignService.js";
import { signCampaignToken } from "../services/campaignTokenService.js";
import { readWorkerHeartbeat } from "../services/workerHeartbeat.js";
import { logger } from "../services/logger.js";
import { personalizeTemplate } from "../services/templateService.js";
import { sendMailgunEmail } from "../services/mailgunService.js";

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;

function extractMailgunMessageId(payload) {
  const raw = String(payload?.id || payload?.messageId || "").trim();
  if (!raw) {
    return "";
  }
  return raw.replace(/^<|>$/g, "");
}

async function buildCampaignProgress(campaignId) {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) {
    return null;
  }

  const counts = await getCampaignStatusCounts(campaignId);

  let stage = "queued";
  if (campaign.import_status === "processing") {
    stage = "importing";
  } else if (campaign.import_status === "failed") {
    stage = "import_failed";
  } else if (campaign.import_status === "completed") {
    if (counts.pending > 0) {
      stage = "sending";
    } else {
      stage = counts.total > 0 ? "completed" : "completed_no_recipients";
    }
  }

  return {
    campaignId,
    stage,
    import: {
      status: campaign.import_status,
      imported: campaign.imported_count,
      invalid: campaign.invalid_count,
      error: campaign.import_error
    },
    delivery: counts
  };
}

function groupUploadedFiles(files) {
  const buckets = {
    file: [],
    assetFiles: [],
    attachmentFiles: []
  };

  for (const file of Array.isArray(files) ? files : []) {
    const fieldname = String(file?.fieldname || "");
    if (fieldname === "file") {
      buckets.file.push(file);
      continue;
    }
    if (fieldname === "assetFiles") {
      buckets.assetFiles.push(file);
      continue;
    }
    if (fieldname === "attachmentFiles") {
      buckets.attachmentFiles.push(file);
    }
  }

  return buckets;
}

export async function uploadCampaignCsv(req, res, next) {
  try {
    const { name, subject, template, replyToEmail } = req.body;
    const groupedFiles = groupUploadedFiles(req.files);
    const file = groupedFiles.file[0];
    const uploadedAssets = groupedFiles.assetFiles;
    const uploadedAttachments = groupedFiles.attachmentFiles;
    let assetManifest = [];
    let attachmentManifest = [];
    try {
      assetManifest = JSON.parse(String(req.body.assetManifest || "[]"));
    } catch {
      assetManifest = [];
    }
    try {
      attachmentManifest = JSON.parse(String(req.body.attachmentManifest || "[]"));
    } catch {
      attachmentManifest = [];
    }

    if (!name || !subject || !template) {
      return res.status(400).json({ error: "name, subject and template are required" });
    }

    if (!file) {
      return res.status(400).json({ error: "CSV file is required" });
    }

    const campaign = await createCampaign({ name, subject, template, replyToEmail: String(replyToEmail || "").trim() || null });
    const campaignToken = signCampaignToken(campaign.id);

    let uploadedAssetCount = 0;
    if (uploadedAssets.length > 0) {
      const mappedAssets = uploadedAssets
        .map((assetFile, index) => {
          const meta = assetManifest[index] || {};
          const cid = String(meta.cid || "").trim();
          if (!cid) {
            return null;
          }
          return {
            cid,
            fileName: String(meta.fileName || assetFile.originalname || cid),
            mimeType: String(assetFile.mimetype || "application/octet-stream"),
            content: assetFile.buffer
          };
        })
        .filter(Boolean);

      if (mappedAssets.length > 0) {
        uploadedAssetCount = await upsertCampaignAssets(campaign.id, mappedAssets);
      }
    }

    let uploadedAttachmentCount = 0;
    if (uploadedAttachments.length > 0) {
      const mappedAttachments = uploadedAttachments.map((attachmentFile, index) => {
        const meta = attachmentManifest[index] || {};
        return {
          fileName: String(meta.fileName || attachmentFile.originalname || `attachment-${index + 1}`),
          mimeType: String(attachmentFile.mimetype || "application/octet-stream"),
          content: attachmentFile.buffer
        };
      });
      uploadedAttachmentCount = await replaceCampaignAttachments(campaign.id, mappedAttachments);
    }

    const importResult = await ingestRecipientsFromCsvBuffer({
      campaignId: campaign.id,
      csvBuffer: file.buffer,
      batchSize: 1000
    });

    logger.info("Campaign CSV ingested", {
      campaignId: campaign.id,
      insertedCount: importResult.insertedCount,
      invalidCount: importResult.invalidCount
    });

    return res.status(201).json({
      message: "Campaign uploaded and recipients stored in database.",
      campaign,
      campaignToken,
      uploadedAssetCount,
      uploadedAttachmentCount,
      insertedCount: importResult.insertedCount,
      invalidCount: importResult.invalidCount
    });
  } catch (error) {
    return next(error);
  }
}

export async function sendCampaign(req, res, next) {
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaign.import_status !== "completed") {
      return res.status(409).json({
        error: "Campaign import must finish before sending",
        importStatus: campaign.import_status
      });
    }

    const cidMatches = String(campaign.template || "").match(/cid:([a-zA-Z0-9._-]+)/g) || [];
    if (cidMatches.length > 0) {
      const expectedCids = [...new Set(cidMatches.map((entry) => entry.replace("cid:", "").trim()).filter(Boolean))];
      const storedAssets = await getCampaignAssets(campaignId);
      const availableCids = new Set(storedAssets.map((asset) => String(asset.cid || "").trim()));
      const missingCids = expectedCids.filter((cid) => !availableCids.has(cid));
      if (missingCids.length > 0) {
        return res.status(400).json({
          error: `Missing inline assets for CID(s): ${missingCids.join(", ")}`
        });
      }
    }

    const workerHealth = await readWorkerHeartbeat(redisConnection);
    if (workerHealth.status !== "online") {
      return res.status(503).json({
        error: "Email worker is not online. Start worker service (or enable RUN_WORKER_IN_API=true) before sending campaign.",
        worker: workerHealth
      });
    }

    // One queued job per recipient gives isolated retry/failure handling.
    const pendingRecipients = await getPendingRecipientsByCampaign(campaignId);
    const sendBatchId = randomUUID();
    const enqueueResult = await enqueueCampaignRecipients(pendingRecipients, 2000, sendBatchId);

    if (pendingRecipients.length === 0) {
      await updateCampaignStatusIfComplete(campaignId);
    }

    return res.status(202).json({
      message: "Campaign queued",
      campaignId,
      sendBatchId,
      queuedJobs: enqueueResult.queued,
      duplicateJobs: enqueueResult.duplicates,
      pendingRecipients: pendingRecipients.length
    });
  } catch (error) {
    return next(error);
  }
}

export async function retryPendingCampaignRecipients(req, res, next) {
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const workerHealth = await readWorkerHeartbeat(redisConnection);
    if (workerHealth.status !== "online") {
      return res.status(503).json({
        error: "Email worker is not online. Start worker service (or enable RUN_WORKER_IN_API=true) before retrying pending recipients.",
        worker: workerHealth
      });
    }

    const pendingRecipients = await getPendingRecipientsByCampaign(campaignId);
    if (pendingRecipients.length === 0) {
      await updateCampaignStatusIfComplete(campaignId);
      return res.status(200).json({
        message: "No pending recipients to requeue",
        campaignId,
        queuedJobs: 0,
        duplicateJobs: 0,
        pendingRecipients: 0
      });
    }

    const sendBatchId = randomUUID();
    const enqueueResult = await enqueueCampaignRecipients(pendingRecipients, 2000, sendBatchId);

    return res.status(202).json({
      message: "Pending recipients requeued",
      campaignId,
      sendBatchId,
      queuedJobs: enqueueResult.queued,
      duplicateJobs: enqueueResult.duplicates,
      pendingRecipients: pendingRecipients.length
    });
  } catch (error) {
    return next(error);
  }
}

export async function getCampaigns(req, res, next) {
  try {
    const limit = Number(req.query?.limit || 50);
    const campaigns = await listCampaigns(limit);
    const rows = await Promise.all(
      campaigns.map(async (campaign) => {
        const counts = await getCampaignStatusCounts(campaign.id);
        return {
          id: String(campaign.id),
          name: campaign.name,
          subject: campaign.subject,
          status: campaign.status,
          importStatus: campaign.import_status,
          importedCount: campaign.imported_count,
          invalidCount: campaign.invalid_count,
          createdAt: campaign.created_at,
          delivery: counts
        };
      })
    );
    return res.status(200).json(rows);
  } catch (error) {
    return next(error);
  }
}

export async function sendCampaignTest(req, res, next) {
  try {
    const campaignId = Number(req.params.id || req.body?.campaignId);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const to = String(req.body?.testEmail || req.body?.to || "").trim();
    if (!to || !EMAIL_REGEX.test(to)) {
      return res.status(400).json({ error: "Valid testEmail is required" });
    }

    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const override = req.body?.override && typeof req.body.override === "object" ? req.body.override : {};
    const subjectTemplate = String(override.subject || campaign.subject || "").trim();
    const htmlTemplate = String(override.template || campaign.template || "").trim();
    const replyTo = String(override.replyToEmail || campaign.reply_to_email || "").trim() || null;

    if (!subjectTemplate || !htmlTemplate) {
      return res.status(400).json({ error: "subject and template are required for test send" });
    }

    const cidMatches = String(htmlTemplate).match(/cid:([a-zA-Z0-9._-]+)/g) || [];
    const expectedCids = [...new Set(cidMatches.map((entry) => entry.replace("cid:", "").trim()).filter(Boolean))];
    const inlineAssets = await getCampaignAssets(campaignId);
    const attachments = await getCampaignAttachments(campaignId);
    const availableCids = new Set(inlineAssets.map((asset) => String(asset.cid || "").trim()));
    const missingCids = expectedCids.filter((cid) => !availableCids.has(cid));
    if (missingCids.length > 0) {
      return res.status(400).json({ error: `Missing inline assets for CID(s): ${missingCids.join(", ")}` });
    }

    const nameFromEmail = String(to.split("@")[0] || "")
      .replace(/[._-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const variables = {
      name: nameFromEmail || "Test User",
      email: to,
      company: "",
      unsubscribe_url: "#"
    };

    const subject = personalizeTemplate(subjectTemplate, variables);
    const html = personalizeTemplate(htmlTemplate, variables);

    const mailgunResult = await sendMailgunEmail({
      to,
      subject,
      html,
      replyTo,
      campaignId,
      inlineAssets,
      attachments
    });

    const messageId = extractMailgunMessageId(mailgunResult);
    if (messageId) {
      await upsertRecipientMessageMapping({
        campaignId,
        recipientEmail: to,
        messageId
      });
    }

    return res.status(200).json({
      ok: true,
      sent: true,
      campaignId,
      to,
      messageId: String(mailgunResult?.id || "")
    });
  } catch (error) {
    return next(error);
  }
}

export async function campaignStatus(req, res, next) {
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const counts = await getCampaignStatusCounts(campaignId);
    return res.status(200).json({ campaignId, ...counts });
  } catch (error) {
    return next(error);
  }
}

export async function campaignProgress(req, res, next) {
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const progress = await buildCampaignProgress(campaignId);
    if (!progress) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    return res.status(200).json(progress);
  } catch (error) {
    return next(error);
  }
}

export async function campaignEvents(req, res, next) {
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const progress = await buildCampaignProgress(campaignId);
    if (!progress) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const sendEvent = (eventName, payload) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent("progress", progress);

    const timer = setInterval(async () => {
      try {
        const latest = await buildCampaignProgress(campaignId);
        if (!latest) {
          sendEvent("error", { error: "Campaign not found" });
          clearInterval(timer);
          res.end();
          return;
        }

        sendEvent("progress", latest);

        if (["completed", "completed_no_recipients", "import_failed"].includes(latest.stage)) {
          sendEvent("done", latest);
          clearInterval(timer);
          res.end();
        }
      } catch (error) {
        sendEvent("error", { error: error.message });
        clearInterval(timer);
        res.end();
      }
    }, 2000);

    req.on("close", () => {
      clearInterval(timer);
    });
  } catch (error) {
    return next(error);
  }
}

export async function campaignEventsList(req, res, next) {
  try {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const limit = Number(req.query.limit || 200);
    const rows = await listCampaignEvents(campaignId, limit);

    return res.status(200).json(
      rows.map((row) => ({
        id: String(row.id),
        campaignId: String(row.campaign_id),
        recipientEmail: String(row.recipient_email || ""),
        type: String(row.event_type || "failed"),
        payload: row.payload || {},
        createdAt: row.created_at
      }))
    );
  } catch (error) {
    return next(error);
  }
}
