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

export async function listCampaigns(limit = 50) {
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const result = await pool.query(
    `
      SELECT id, name, subject, reply_to_email, template, status, import_status, imported_count, invalid_count, import_error, created_at
      FROM campaigns
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [boundedLimit]
  );
  return result.rows;
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

    const result = await pool.query(
      `
      INSERT INTO recipients (campaign_id, email, name, company)
      SELECT $1::BIGINT, data.email, data.name, data.company
      FROM UNNEST($2::TEXT[], $3::TEXT[], $4::TEXT[]) AS data(email, name, company)
      ON CONFLICT DO NOTHING
    `,
      [campaignId, emails, names, companies]
    );
    inserted += result.rowCount;
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

export async function replaceCampaignAttachments(campaignId, attachments = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_attachments (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        content BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_campaign_attachments_campaign_id ON campaign_attachments(campaign_id)`);

    await client.query(`DELETE FROM campaign_attachments WHERE campaign_id = $1`, [campaignId]);

    let written = 0;
    for (const attachment of attachments) {
      await client.query(
        `
          INSERT INTO campaign_attachments (campaign_id, file_name, mime_type, content)
          VALUES ($1, $2, $3, $4)
        `,
        [campaignId, attachment.fileName, attachment.mimeType, attachment.content]
      );
      written += 1;
    }

    await client.query("COMMIT");
    return written;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getCampaignAttachments(campaignId) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_attachments (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      content BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_attachments_campaign_id ON campaign_attachments(campaign_id)`);

  const result = await pool.query(
    `
      SELECT file_name, mime_type, content
      FROM campaign_attachments
      WHERE campaign_id = $1
      ORDER BY id ASC
    `,
    [campaignId]
  );

  return result.rows;
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

let campaignEventsSchemaReady = false;
let recipientMessageMapSchemaReady = false;

async function ensureCampaignEventsSchema() {
  if (campaignEventsSchemaReady) {
    return;
  }

  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS campaign_events (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_email VARCHAR(320) NOT NULL,
        event_type VARCHAR(40) NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign_id_created_at ON campaign_events(campaign_id, created_at DESC)`);
  campaignEventsSchemaReady = true;
}

async function ensureRecipientMessageMapSchema() {
  if (recipientMessageMapSchemaReady) {
    return;
  }

  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS recipient_message_map (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_id BIGINT,
        recipient_email VARCHAR(320) NOT NULL,
        message_id VARCHAR(255) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipient_message_map_campaign_id ON recipient_message_map(campaign_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_recipient_message_map_recipient_email ON recipient_message_map(LOWER(recipient_email))`);
  recipientMessageMapSchemaReady = true;
}

export async function appendCampaignEvent(campaignId, recipientEmail, eventType, payload = {}) {
  try {
    await ensureCampaignEventsSchema();
    await pool.query(
      `
        INSERT INTO campaign_events (campaign_id, recipient_email, event_type, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [campaignId, recipientEmail, String(eventType || "").toLowerCase(), JSON.stringify(payload || {})]
    );
  } catch (error) {
    if (error?.code === "42P01") {
      campaignEventsSchemaReady = false;
      await ensureCampaignEventsSchema();
      await pool.query(
        `
          INSERT INTO campaign_events (campaign_id, recipient_email, event_type, payload)
          VALUES ($1, $2, $3, $4::jsonb)
        `,
        [campaignId, recipientEmail, String(eventType || "").toLowerCase(), JSON.stringify(payload || {})]
      );
      return;
    }
    throw error;
  }
}

export async function listCampaignEvents(campaignId, limit = 200) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  try {
    await ensureCampaignEventsSchema();
    const result = await pool.query(
      `
        SELECT id, campaign_id, recipient_email, event_type, payload, created_at
        FROM campaign_events
        WHERE campaign_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [campaignId, boundedLimit]
    );
    return result.rows;
  } catch (error) {
    if (error?.code === "42P01") {
      campaignEventsSchemaReady = false;
      await ensureCampaignEventsSchema();
      const result = await pool.query(
        `
          SELECT id, campaign_id, recipient_email, event_type, payload, created_at
          FROM campaign_events
          WHERE campaign_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [campaignId, boundedLimit]
      );
      return result.rows;
    }
    throw error;
  }
}

export async function upsertRecipientMessageMapping({ campaignId, recipientId = null, recipientEmail, messageId }) {
  const cleanCampaignId = Number(campaignId);
  const cleanRecipientId = recipientId === null || recipientId === undefined ? null : Number(recipientId);
  const cleanEmail = String(recipientEmail || "").trim();
  const cleanMessageId = String(messageId || "").trim();

  if (!Number.isInteger(cleanCampaignId) || cleanCampaignId <= 0 || !cleanEmail || !cleanMessageId) {
    return null;
  }

  try {
    await ensureRecipientMessageMapSchema();
    const result = await pool.query(
      `
        INSERT INTO recipient_message_map (campaign_id, recipient_id, recipient_email, message_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (message_id)
        DO UPDATE SET campaign_id = EXCLUDED.campaign_id,
                      recipient_id = EXCLUDED.recipient_id,
                      recipient_email = EXCLUDED.recipient_email
        RETURNING campaign_id, recipient_id, recipient_email, message_id
      `,
      [cleanCampaignId, Number.isInteger(cleanRecipientId) && cleanRecipientId > 0 ? cleanRecipientId : null, cleanEmail, cleanMessageId]
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === "42P01") {
      recipientMessageMapSchemaReady = false;
      await ensureRecipientMessageMapSchema();
      const result = await pool.query(
        `
          INSERT INTO recipient_message_map (campaign_id, recipient_id, recipient_email, message_id)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (message_id)
          DO UPDATE SET campaign_id = EXCLUDED.campaign_id,
                        recipient_id = EXCLUDED.recipient_id,
                        recipient_email = EXCLUDED.recipient_email
          RETURNING campaign_id, recipient_id, recipient_email, message_id
        `,
        [cleanCampaignId, Number.isInteger(cleanRecipientId) && cleanRecipientId > 0 ? cleanRecipientId : null, cleanEmail, cleanMessageId]
      );
      return result.rows[0] || null;
    }
    throw error;
  }
}

export async function findRecipientMessageMapping(messageId) {
  const cleanMessageId = String(messageId || "").trim();
  if (!cleanMessageId) {
    return null;
  }

  try {
    await ensureRecipientMessageMapSchema();
    const result = await pool.query(
      `
        SELECT campaign_id, recipient_id, recipient_email, message_id
        FROM recipient_message_map
        WHERE message_id = $1
        LIMIT 1
      `,
      [cleanMessageId]
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === "42P01") {
      recipientMessageMapSchemaReady = false;
      await ensureRecipientMessageMapSchema();
      const result = await pool.query(
        `
          SELECT campaign_id, recipient_id, recipient_email, message_id
          FROM recipient_message_map
          WHERE message_id = $1
          LIMIT 1
        `,
        [cleanMessageId]
      );
      return result.rows[0] || null;
    }
    throw error;
  }
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
