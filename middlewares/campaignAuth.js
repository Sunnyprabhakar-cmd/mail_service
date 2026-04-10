import { verifyCampaignToken } from "../services/campaignTokenService.js";

function getBearerToken(authorizationHeader) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, value] = authorizationHeader.split(" ");
  if (!scheme || !value || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return value;
}

export function requireCampaignAccess(req, res, next) {
  try {
    const routeCampaignId = Number(req.params.id);
    const bodyCampaignId = Number(req.body?.campaignId);
    const campaignId = Number.isInteger(routeCampaignId) && routeCampaignId > 0
      ? routeCampaignId
      : bodyCampaignId;
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "Invalid campaign id" });
    }

    const bearerToken = getBearerToken(req.headers.authorization);
    const headerToken = req.headers["x-campaign-token"];
    const queryToken = req.query.campaignToken;
    const token = bearerToken || headerToken || queryToken;

    if (!token) {
      return res.status(401).json({ error: "Campaign token missing" });
    }

    const decoded = verifyCampaignToken(token);
    if (Number(decoded.campaignId) !== campaignId) {
      return res.status(403).json({ error: "Forbidden for this campaign" });
    }

    req.campaignAuth = decoded;
    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Invalid or expired campaign token" });
  }
}
