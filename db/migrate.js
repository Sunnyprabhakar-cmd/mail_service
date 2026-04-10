import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationMaxRetries = Math.max(1, Number(process.env.MIGRATION_MAX_RETRIES || 12));
const migrationRetryDelayMs = Math.max(250, Number(process.env.MIGRATION_RETRY_DELAY_MS || 5000));
const allowMigrationFailure = String(process.env.ALLOW_MIGRATION_FAILURE || "false").toLowerCase() === "true";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableMigrationError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "57P03", "08006", "08001"].includes(code)) {
    return true;
  }

  return (
    message.includes("connection terminated unexpectedly") ||
    message.includes("server closed the connection unexpectedly") ||
    message.includes("terminating connection due to administrator command")
  );
}

async function runMigrations() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");
  await pool.query(sql);

  // Idempotent upgrades for existing databases.
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS import_status VARCHAR(20) NOT NULL DEFAULT 'queued'`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS imported_count INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS invalid_count INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS import_error TEXT`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(320)`);

  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS campaign_assets (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        cid VARCHAR(255) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        content BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (campaign_id, cid)
      )
    `
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_assets_campaign_id ON campaign_assets(campaign_id)`);

  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS campaign_attachments (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        content BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_attachments_campaign_id ON campaign_attachments(campaign_id)`);

  await pool.query(
    `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'campaigns_import_status_check'
      ) THEN
        ALTER TABLE campaigns
        ADD CONSTRAINT campaigns_import_status_check
        CHECK (import_status IN ('queued', 'processing', 'completed', 'failed'));
      END IF;
    END $$;
  `
  );

  console.log("Database schema migrated successfully");
}

async function runWithRetry() {
  for (let attempt = 1; attempt <= migrationMaxRetries; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`Migration retry ${attempt}/${migrationMaxRetries}...`);
      }
      await runMigrations();
      return;
    } catch (error) {
      const retryable = isRetryableMigrationError(error);
      const hasNext = attempt < migrationMaxRetries;

      if (retryable && hasNext) {
        console.warn(
          `Migration attempt ${attempt} failed with retryable error (${error.code || error.message}). Retrying in ${migrationRetryDelayMs}ms...`
        );
        await sleep(migrationRetryDelayMs);
        continue;
      }

      throw error;
    }
  }
}

runWithRetry()
  .catch((error) => {
    if (allowMigrationFailure) {
      console.warn("Migration failed, but ALLOW_MIGRATION_FAILURE=true so deployment will continue.");
      console.warn(error);
      process.exitCode = 0;
      return;
    }
    console.error("Failed to run migrations", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
