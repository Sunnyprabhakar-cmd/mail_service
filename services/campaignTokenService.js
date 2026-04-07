import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function signCampaignToken(campaignId) {
  return jwt.sign({ campaignId }, env.campaignTokenSecret, {
    expiresIn: env.campaignTokenExpiresIn
  });
}

export function verifyCampaignToken(token) {
  return jwt.verify(token, env.campaignTokenSecret);
}
