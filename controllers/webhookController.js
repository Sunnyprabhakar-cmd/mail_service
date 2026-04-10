import {
  appendCampaignEvent,
  updateCampaignStatusIfComplete,
  updateRecipientStatusByEmail
} from "../db/queries.js";
import { env } from "../config/env.js";
import { logger } from "../services/logger.js";

function coerceCampaignId(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!text) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function extractWebhookFields(body) {
  const parsedBody = parseMaybeJson(body) || {};
  const eventDataRaw = parseMaybeJson(parsedBody["event-data"] || parsedBody.eventData) || {};
  const eventData = typeof eventDataRaw === "object" && eventDataRaw !== null ? eventDataRaw : {};
  const message = (eventData.message && typeof eventData.message === "object") ? eventData.message : {};
  const userVariables = (eventData["user-variables"] && typeof eventData["user-variables"] === "object")
    ? eventData["user-variables"]
    : ((eventData.userVariables && typeof eventData.userVariables === "object") ? eventData.userVariables : {});
  const headers = (message.headers && typeof message.headers === "object") ? message.headers : {};

  const normalizedEvent = String(
    parsedBody.event
      || eventData.event
      || parsedBody["event-data"]?.event
      || ""
  ).toLowerCase().trim();

  const recipient = String(
    parsedBody.recipient
      || eventData.recipient
      || parsedBody.email
      || eventData.email
      || ""
  ).trim();

  const campaignId = coerceCampaignId(
    parsedBody.campaignId
      || parsedBody.campaign_id
      || userVariables.campaignId
      || userVariables.campaign_id
      || headers["X-Campaign-Id"]
      || headers["x-campaign-id"]
      || ""
  );

  const reason = String(
    parsedBody.reason
      || eventData.reason
      || eventData["delivery-status"]?.description
      || ""
  ).trim();

  return {
    normalizedEvent,
    recipient,
    campaignId,
    reason,
    eventData,
    userVariables
  };
}

export async function handleMailgunWebhook(req, res, next) {
  try {
    if (env.webhookSecret) {
      const incomingSecret = req.headers["x-webhook-secret"];
      if (incomingSecret !== env.webhookSecret) {
        return res.status(401).json({ error: "Unauthorized webhook" });
      }
    }

    const {
      normalizedEvent,
      recipient,
      campaignId: numericCampaignId,
      reason,
      eventData,
      userVariables
    } = extractWebhookFields(req.body);

    if (!normalizedEvent || !recipient || !numericCampaignId) {
      return res.status(400).json({ error: "event, recipient and campaignId are required" });
    }

    const successEvents = new Set(["accepted", "delivered", "opened", "clicked"]);
    const failureEvents = new Set(["failed", "bounced", "rejected", "complained"]);

    if (!successEvents.has(normalizedEvent) && !failureEvents.has(normalizedEvent)) {
      return res.status(200).json({ message: "Event ignored", event: normalizedEvent });
    }

    let status = "pending";
    let error = null;

    if (failureEvents.has(normalizedEvent)) {
      status = "failed";
      error = reason || `Mailgun event: ${normalizedEvent}`;
    } else {
      status = "sent";
    }

    const updatedRows = await updateRecipientStatusByEmail(numericCampaignId, recipient, status, error);
    await appendCampaignEvent(numericCampaignId, recipient, normalizedEvent, {
      status,
      reason: reason || null,
      _source: "mailgun-webhook",
      eventData,
      userVariables
    });
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
