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

export function requireApiToken(req, res, next) {
  const bearerToken = getBearerToken(req.headers.authorization);
  const headerToken = req.headers["x-api-token"];
  const token = bearerToken || headerToken;
  const expectedToken = String(process.env.API_TOKEN || process.env.BACKEND_API_TOKEN || "dev-token-12345").trim();

  if (!expectedToken) {
    return res.status(500).json({ error: "API token is not configured" });
  }

  if (String(token || "").trim() !== expectedToken) {
    return res.status(401).json({ error: "Invalid token" });
  }

  return next();
}