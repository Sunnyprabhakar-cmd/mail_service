import { pool } from "./pool.js";

let replyToEmailSchemaReady = false;

async function ensureReplyToEmailSchema() {
  if (replyToEmailSchemaReady) {
    return;
  }

  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(320)`);
  replyToEmailSchemaReady = true;
}

export async function createCampaign({ name, subject, template, replyToEmail = null }) {
  try {
    const result = await pool.query(
      `INSERT INTO campaigns (name, subject, template, reply_to_email) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, subject, template, replyToEmail]
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code === "42703" || String(error?.message || "").includes("reply_to_email")) {
      replyToEmailSchemaReady = false;
      await ensureReplyToEmailSchema();
      const result = await pool.query(
        `INSERT INTO campaigns (name, subject, template, reply_to_email) VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, subject, template, replyToEmail]
      );
      return result.rows[0];
    }
    throw error;
  }
}

export async function getCampaignById(campaignId) {
  try {
    const result = await pool.query(
      `
      SELECT id, name, subject, reply_to_email, template, status, import_status, imported_count, invalid_count, import_error, created_at
      FROM campaigns
      WHERE id = $1
    `,
      [campaignId]
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === "42703" || String(error?.message || "").includes("reply_to_email")) {
      replyToEmailSchemaReady = false;
      await ensureReplyToEmailSchema();
      const result = await pool.query(
        `
        SELECT id, name, subject, reply_to_email, template, status, import_status, imported_count, invalid_count, import_error, created_at
        FROM campaigns
        WHERE id = $1
      `,
        [campaignId]
      );
      return result.rows[0] || null;
    }
    throw error;
  }
}

export async function setCampaignImportStatus(campaignId, importStatus, importedCount = 0, invalidCount = 0, importError = null) {
  await pool.query(
    `
    UPDATE campaigns
    SET import_status = $2,
        imported_count = $3,
        invalid_count = $4,
        import_error = $5
    WHERE id = $1
  `,
    [campaignId, importStatus, importedCount, invalidCount, importError]
  );
}

export async function batchInsertRecipients(campaignId, recipients, batchSize = 1000) {
  let inserted = 0;

  // Insert recipients in chunks to avoid oversized SQL payloads.
  for (let offset = 0; offset < recipients.length; offset += batchSize) {
    const chunk = recipients.slice(offset, offset + batchSize);
    if (chunk.length === 0) {
      continue;
    }

    const emails = chunk.map((recipient) => recipient.email);
    const names = chunk.map((recipient) => recipient.name || null);
    const companies = chunk.map((recipient) => recipient.company || null);

    await pool.query(
      `
      INSERT INTO recipients (campaign_id, email, name, company)
      SELECT $1::BIGINT, data.email, data.name, data.company
      FROM UNNEST($2::TEXT[], $3::TEXT[], $4::TEXT[]) AS data(email, name, company)
    `,
      [campaignId, emails, names, companies]
    );
    inserted += chunk.length;
  }

  return inserted;
}

export async function getPendingRecipientsByCampaign(campaignId) {
  const result = await pool.query(
    `SELECT id, campaign_id, email FROM recipients WHERE campaign_id = $1 AND status = 'pending'`,
    [campaignId]
  );
  return result.rows;
}

export async function getCampaignStatusCounts(campaignId) {
  const result = await pool.query(
    `
    SELECT
      COUNT(*)::INT AS total,
      COUNT(*) FILTER (WHERE status = 'sent')::INT AS sent,
      COUNT(*) FILTER (WHERE status = 'failed')::INT AS failed,
      COUNT(*) FILTER (WHERE status = 'pending')::INT AS pending
    FROM recipients
    WHERE campaign_id = $1
  `,
    [campaignId]
  );

  return result.rows[0];
}

export async function getRecipientWithCampaign(recipientId, campaignId) {
  try {
    const result = await pool.query(
      `
      SELECT
        r.id AS recipient_id,
        r.campaign_id,
        r.email,
        r.name,
        r.company,
        c.subject,
        c.reply_to_email,
        c.template
      FROM recipients r
      JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.id = $1 AND r.campaign_id = $2
      LIMIT 1
    `,
      [recipientId, campaignId]
    );

    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === "42703" || String(error?.message || "").includes("reply_to_email")) {
      replyToEmailSchemaReady = false;
      await ensureReplyToEmailSchema();
      const result = await pool.query(
        `
        SELECT
          r.id AS recipient_id,
          r.campaign_id,
          r.email,
          r.name,
          r.company,
          c.subject,
          c.reply_to_email,
          c.template
        FROM recipients r
        JOIN campaigns c ON c.id = r.campaign_id
        WHERE r.id = $1 AND r.campaign_id = $2
        LIMIT 1
      `,
        [recipientId, campaignId]
      );

      return result.rows[0] || null;
    }
    throw error;
  }
}

export async function markRecipientAsSent(recipientId) {
  await pool.query(`UPDATE recipients SET status = 'sent', error = NULL WHERE id = $1`, [recipientId]);
}

export async function markRecipientAsFailed(recipientId, errorMessage) {
  await pool.query(`UPDATE recipients SET status = 'failed', error = $2 WHERE id = $1`, [recipientId, errorMessage]);
}

export async function updateCampaignStatusIfComplete(campaignId) {
  // Campaign is marked as sent once no pending recipients remain.
  const result = await pool.query(
    `
    UPDATE campaigns
    SET status = 'sent'
    WHERE id = $1
      AND NOT EXISTS (
        SELECT 1 FROM recipients WHERE campaign_id = $1 AND status = 'pending'
      )
    RETURNING id, status
  `,
    [campaignId]
  );

  return result.rows[0] || null;
}

let campaignAssetsSchemaReady = false;

async function ensureCampaignAssetsSchema() {
  if (campaignAssetsSchemaReady) {
    return;
  }

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
  campaignAssetsSchemaReady = true;
}

export async function upsertCampaignAssets(campaignId, assets = []) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return 0;
  }

  let written = 0;
  for (const asset of assets) {
    try {
      await ensureCampaignAssetsSchema();
      await pool.query(
        `
          INSERT INTO campaign_assets (campaign_id, cid, file_name, mime_type, content)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (campaign_id, cid)
          DO UPDATE SET file_name = EXCLUDED.file_name,
                        mime_type = EXCLUDED.mime_type,
                        content = EXCLUDED.content
        `,
        [campaignId, asset.cid, asset.fileName, asset.mimeType, asset.content]
      );
    } catch (error) {
      if (error?.code === "42P01") {
        campaignAssetsSchemaReady = false;
        await ensureCampaignAssetsSchema();
        await pool.query(
          `
            INSERT INTO campaign_assets (campaign_id, cid, file_name, mime_type, content)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (campaign_id, cid)
            DO UPDATE SET file_name = EXCLUDED.file_name,
                          mime_type = EXCLUDED.mime_type,
                          content = EXCLUDED.content
          `,
          [campaignId, asset.cid, asset.fileName, asset.mimeType, asset.content]
        );
      } else {
        throw error;
      }
    }
    written += 1;
  }

  return written;
}

export async function getCampaignAssets(campaignId) {
  try {
    await ensureCampaignAssetsSchema();
    const result = await pool.query(
      `
        SELECT cid, file_name, mime_type, content
        FROM campaign_assets
        WHERE campaign_id = $1
      `,
      [campaignId]
    );
    return result.rows;
  } catch (error) {
    if (error?.code === "42P01") {
      campaignAssetsSchemaReady = false;
      await ensureCampaignAssetsSchema();
      const result = await pool.query(
        `
          SELECT cid, file_name, mime_type, content
          FROM campaign_assets
          WHERE campaign_id = $1
        `,
        [campaignId]
      );
      return result.rows;
    }
    throw error;
  }
}

export async function updateRecipientStatusByEmail(campaignId, email, status, error = null) {
  const result = await pool.query(
    `
    UPDATE recipients
    SET status = $3, error = $4
    WHERE campaign_id = $1 AND LOWER(email) = LOWER($2)
    RETURNING id, email, status
  `,
    [campaignId, email, status, error]
  );

  return result.rows;
}

export async function deleteOldCampaigns(days) {
  const result = await pool.query(
    `
    DELETE FROM campaigns
    WHERE created_at < NOW() - ($1::INT * INTERVAL '1 day')
    RETURNING id
  `,
    [days]
  );

  return result.rowCount;
}
