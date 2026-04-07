import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

runMigrations()
  .catch((error) => {
    console.error("Failed to run migrations", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
