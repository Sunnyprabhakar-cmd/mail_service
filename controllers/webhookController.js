import {
  appendCampaignEvent,
  findRecipientMessageMapping,
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

function extractMessageId(eventData) {
  const message = (eventData?.message && typeof eventData.message === "object") ? eventData.message : {};
  const headers = (message.headers && typeof message.headers === "object") ? message.headers : {};
  const raw = String(
    eventData?.["message-id"]
      || headers["message-id"]
      || headers["Message-Id"]
      || headers["Message-ID"]
      || ""
  ).trim();
  if (!raw) {
    return "";
  }
  return raw.replace(/^<|>$/g, "");
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

  const messageId = extractMessageId(eventData);

  return {
    normalizedEvent,
    recipient,
    campaignId,
    reason,
    messageId,
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
      campaignId,
      reason,
      messageId,
      eventData,
      userVariables
    } = extractWebhookFields(req.body);

    let resolvedCampaignId = campaignId;
    let resolvedRecipient = recipient;

    if ((!resolvedCampaignId || !resolvedRecipient) && messageId) {
      const mapped = await findRecipientMessageMapping(messageId);
      if (mapped) {
        if (!resolvedCampaignId) {
          resolvedCampaignId = Number(mapped.campaign_id);
        }
        if (!resolvedRecipient) {
          resolvedRecipient = String(mapped.recipient_email || "").trim();
        }
      }
    }

    if (!normalizedEvent || !resolvedRecipient || !resolvedCampaignId) {
      logger.warn("Mailgun webhook ignored: missing correlation fields", {
        hasEvent: Boolean(normalizedEvent),
        hasRecipient: Boolean(resolvedRecipient),
        hasCampaignId: Boolean(resolvedCampaignId),
        hasMessageId: Boolean(messageId)
      });
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

    const updatedRows = await updateRecipientStatusByEmail(resolvedCampaignId, resolvedRecipient, status, error);
    await appendCampaignEvent(resolvedCampaignId, resolvedRecipient, normalizedEvent, {
      status,
      reason: reason || null,
      _source: "mailgun-webhook",
      messageId: messageId || null,
      eventData,
      userVariables
    });
    await updateCampaignStatusIfComplete(resolvedCampaignId);

    logger.info("Mailgun webhook processed", {
      event: normalizedEvent,
      recipient: resolvedRecipient,
      campaignId: resolvedCampaignId,
      messageId: messageId || null,
      updates: updatedRows.length
    });

    return res.status(200).json({ success: true, updated: updatedRows.length });
  } catch (error) {
    return next(error);
  }
}
