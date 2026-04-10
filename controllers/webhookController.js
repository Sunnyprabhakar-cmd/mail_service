import crypto from "crypto";
import {
  appendCampaignEvent,
  findMostRecentCampaignForRecipientEmail,
  findRecipientMessageMapping,
  updateCampaignStatusIfComplete,
  updateRecipientStatusByEmail
} from "../db/queries.js";
import { env } from "../config/env.js";
import { logger } from "../services/logger.js";

function verifyMailgunSignature(req) {
  try {
    const signatureBlock = (req.body && typeof req.body.signature === "object") ? req.body.signature : {};
    const timestamp = String(
      req.body?.timestamp
      || req.body?.["signature[timestamp]"]
      || signatureBlock.timestamp
      || ""
    ).trim();
    const token = String(
      req.body?.token
      || req.body?.["signature[token]"]
      || signatureBlock.token
      || ""
    ).trim();
    const providedSignatureRaw = (typeof req.body?.signature === "string")
      ? req.body.signature
      : (
        req.body?.["signature[signature]"]
        || signatureBlock.signature
        || ""
      );
    const providedSignature = String(providedSignatureRaw).trim().toLowerCase();

    if (!timestamp || !token || !providedSignature) {
      logger.warn("Mailgun webhook: missing timestamp, token, or signature");
      return false;
    }

    const data = `${timestamp}${token}`;
    if (!env.webhookSecret) {
      logger.warn("Mailgun webhook signing secret is not configured");
      return false;
    }

    const expectedSignature = crypto
      .createHmac("sha256", env.webhookSecret)
      .update(data)
      .digest("hex")
      .toLowerCase();

    const provided = Buffer.from(providedSignature, "utf8");
    const expected = Buffer.from(String(expectedSignature), "utf8");
    if (provided.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(provided, expected);
  } catch (error) {
    logger.error("Error verifying Mailgun signature", { error: error.message });
    return false;
  }
}

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
      || eventData?.messageId
      || eventData?.["Message-Id"]
      || eventData?.["Message-ID"]
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
  const topLevelUserVariablesRaw = parseMaybeJson(parsedBody["user-variables"] || parsedBody.userVariables) || {};
  const topLevelUserVariables = (typeof topLevelUserVariablesRaw === "object" && topLevelUserVariablesRaw !== null)
    ? topLevelUserVariablesRaw
    : {};
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
      || topLevelUserVariables.campaignId
      || topLevelUserVariables.campaign_id
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

  const messageId = String(
    extractMessageId(eventData)
      || parsedBody["message-id"]
      || parsedBody.messageId
      || parsedBody["Message-Id"]
      || parsedBody["Message-ID"]
      || ""
  ).trim().replace(/^<|>$/g, "");

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
    // Verify Mailgun signature using HMAC-SHA256
    if (!verifyMailgunSignature(req)) {
      logger.warn("Mailgun webhook signature verification failed");
      return res.status(401).json({ error: "Unauthorized webhook" });
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

    if (!resolvedCampaignId && resolvedRecipient) {
      const inferred = await findMostRecentCampaignForRecipientEmail(resolvedRecipient);
      if (inferred?.campaign_id) {
        resolvedCampaignId = Number(inferred.campaign_id);
      }
    }

    if (!normalizedEvent || !resolvedRecipient || !resolvedCampaignId) {
      logger.warn("Mailgun webhook ignored: missing correlation fields", {
        hasEvent: Boolean(normalizedEvent),
        hasRecipient: Boolean(resolvedRecipient),
        hasCampaignId: Boolean(resolvedCampaignId),
        hasMessageId: Boolean(messageId)
      });
      return res.status(200).json({
        success: true,
        ignored: true,
        reason: "Missing event, recipient, or campaign correlation"
      });
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
