import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

function resolveSslConfig() {
  const rawToggle = String(process.env.DATABASE_SSL || "auto").trim().toLowerCase();
  const rawSslMode = String(process.env.DATABASE_SSL_MODE || process.env.PGSSLMODE || "").trim().toLowerCase();
  const dbUrl = String(env.databaseUrl || "");
  const nodeEnv = String(env.nodeEnv || process.env.NODE_ENV || "development").trim().toLowerCase();
  const isLocalRuntime = ["development", "dev", "test"].includes(nodeEnv);

  if (["false", "0", "no", "off", "disable"].includes(rawToggle)) {
    return false;
  }

  const sslModeForcesTls = ["require", "verify-ca", "verify-full"].includes(rawSslMode);
  const urlForcesTls = /[?&]sslmode=require(?:&|$)/i.test(dbUrl);
  let hostLooksInternal = false;
  try {
    const parsed = new URL(dbUrl);
    hostLooksInternal = /\.internal$/i.test(parsed.hostname) || /render\.internal$/i.test(parsed.hostname);
  } catch {
    hostLooksInternal = false;
  }

  const autoEnablesTls = rawToggle === "auto" && !isLocalRuntime && !hostLooksInternal;
  const shouldUseTls =
    ["true", "1", "yes", "on", "require"].includes(rawToggle) ||
    sslModeForcesTls ||
    urlForcesTls ||
    autoEnablesTls;

  if (!shouldUseTls) {
    return false;
  }

  const rejectUnauthorized = !["false", "0", "no", "off"].includes(
    String(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED || "false").trim().toLowerCase()
  );

  return { rejectUnauthorized };
}

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: resolveSslConfig(),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});
