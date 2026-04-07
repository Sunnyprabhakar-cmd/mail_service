import {
  updateCampaignStatusIfComplete,
  updateRecipientStatusByEmail
} from "../db/queries.js";
import { env } from "../config/env.js";
import { logger } from "../services/logger.js";

export async function handleMailgunWebhook(req, res, next) {
  try {
    if (env.webhookSecret) {
      const incomingSecret = req.headers["x-webhook-secret"];
      if (incomingSecret !== env.webhookSecret) {
        return res.status(401).json({ error: "Unauthorized webhook" });
      }
    }

    const { event, recipient, campaignId, reason } = req.body;

    if (!event || !recipient || !campaignId) {
      return res.status(400).json({ error: "event, recipient and campaignId are required" });
    }

    const numericCampaignId = Number(campaignId);
    if (!Number.isInteger(numericCampaignId) || numericCampaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaignId" });
    }

    const normalizedEvent = String(event).toLowerCase();
    let status = "pending";
    let error = null;

    if (["delivered", "opened"].includes(normalizedEvent)) {
      status = "sent";
    } else if (["failed", "bounced", "rejected", "complained"].includes(normalizedEvent)) {
      status = "failed";
      error = reason || `Mailgun event: ${normalizedEvent}`;
    } else {
      return res.status(200).json({ message: "Event ignored", event: normalizedEvent });
    }

    const updatedRows = await updateRecipientStatusByEmail(numericCampaignId, recipient, status, error);
    await updateCampaignStatusIfComplete(numericCampaignId);

    logger.info("Mailgun webhook processed", {
      event: normalizedEvent,
      recipient,
      campaignId: numericCampaignId,
      updates: updatedRows.length
    });

    return res.status(200).json({ success: true, updated: updatedRows.length });
  } catch (error) {
    return next(error);
  }
}
