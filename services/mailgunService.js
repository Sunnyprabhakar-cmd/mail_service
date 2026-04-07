import axios from "axios";
import { env } from "../config/env.js";

const mailgunClient = axios.create({
  baseURL: `https://api.mailgun.net/v3/${env.mailgunDomain}`,
  auth: {
    username: "api",
    password: env.mailgunApiKey
  },
  timeout: 15000
});

export async function sendMailgunEmail({ to, subject, html }) {
  const body = new URLSearchParams({
    from: env.mailgunFrom,
    to,
    subject,
    html
  });

  const response = await mailgunClient.post("/messages", body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  return response.data;
}
