import axios from "axios";
import FormData from "form-data";
import { env } from "../config/env.js";

const mailgunClient = axios.create({
  baseURL: `https://api.mailgun.net/v3/${env.mailgunDomain}`,
  auth: {
    username: "api",
    password: env.mailgunApiKey
  },
  timeout: 15000
});

export async function sendMailgunEmail({ to, subject, html, replyTo, inlineAssets = [], attachments = [] }) {
  const body = new FormData();
  body.append("from", env.mailgunFrom);
  body.append("to", to);
  body.append("subject", subject);
  body.append("html", html);
  if (String(replyTo || "").trim()) {
    body.append("h:Reply-To", String(replyTo).trim());
  }

  for (const asset of inlineAssets) {
    const cid = String(asset.cid || "").trim();
    if (!cid) {
      continue;
    }
    body.append("inline", asset.content, {
      filename: cid,
      contentType: String(asset.mime_type || "application/octet-stream")
    });
  }

  for (const attachment of attachments) {
    const fileName = String(attachment.file_name || attachment.fileName || "").trim();
    if (!fileName) {
      continue;
    }
    body.append("attachment", attachment.content, {
      filename: fileName,
      contentType: String(attachment.mime_type || attachment.mimeType || "application/octet-stream")
    });
  }

  try {
    const response = await mailgunClient.post("/messages", body, {
      headers: {
        ...body.getHeaders()
      }
    });

    return response.data;
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const message = typeof data === "string"
      ? data
      : String(data?.message || data?.error || error.message || "Mailgun send failed");

    const details = status ? `Mailgun ${status}: ${message}` : message;
    const wrapped = new Error(details);
    wrapped.cause = error;
    throw wrapped;
  }
}
