import {
  createCampaign,
  getCampaignById,
  getCampaignAssets,
  getCampaignStatusCounts,
  getPendingRecipientsByCampaign,
  upsertCampaignAssets,
  updateCampaignStatusIfComplete
} from "../db/queries.js";
import { redisConnection } from "../queue/redis.js";
import { enqueueCampaignRecipients } from "../queue/emailQueue.js";
import { ingestRecipientsFromCsvBuffer } from "../services/campaignService.js";
import { signCampaignToken } from "../services/campaignTokenService.js";
import { readWorkerHeartbeat } from "../services/workerHeartbeat.js";
import { logger } from "../services/logger.js";

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

export async function uploadCampaignCsv(req, res, next) {
  try {
    const { name, subject, template } = req.body;
    const file = req.files?.file?.[0];
    const uploadedAssets = Array.isArray(req.files?.assetFiles) ? req.files.assetFiles : [];
    let assetManifest = [];
    try {
      assetManifest = JSON.parse(String(req.body.assetManifest || "[]"));
    } catch {
      assetManifest = [];
    }

    if (!name || !subject || !template) {
      return res.status(400).json({ error: "name, subject and template are required" });
    }

    if (!file) {
      return res.status(400).json({ error: "CSV file is required" });
    }

    const campaign = await createCampaign({ name, subject, template });
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
    const enqueueResult = await enqueueCampaignRecipients(pendingRecipients);

    if (pendingRecipients.length === 0) {
      await updateCampaignStatusIfComplete(campaignId);
    }

    return res.status(202).json({
      message: "Campaign queued",
      campaignId,
      queuedJobs: enqueueResult.queued,
      duplicateJobs: enqueueResult.duplicates,
      pendingRecipients: pendingRecipients.length
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
