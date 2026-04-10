import { logger } from "../services/logger.js";

export function notFoundHandler(_req, res) {
  return res.status(404).json({ error: "Route not found" });
}

export function errorHandler(error, _req, res, _next) {
  logger.error("Request failed", { message: error.message, stack: error.stack });

  if (error.message === "Only CSV files are allowed") {
    return res.status(400).json({ error: error.message });
  }

  if (error.message === "Only image files are allowed for assetFiles") {
    return res.status(400).json({ error: error.message });
  }

  if (String(error.message || "").startsWith("Unexpected file field:")) {
    return res.status(400).json({ error: error.message });
  }

  const detail = String(error?.message || "Unknown error");
  return res.status(500).json({ error: `Internal server error: ${detail}` });
}
