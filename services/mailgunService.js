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

export async function sendMailgunEmail({ to, subject, html, inlineAssets = [] }) {
  const body = new FormData();
  body.append("from", env.mailgunFrom);
  body.append("to", to);
  body.append("subject", subject);
  body.append("html", html);

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

  const response = await mailgunClient.post("/messages", body, {
    headers: {
      ...body.getHeaders()
    }
  });

  return response.data;
}
