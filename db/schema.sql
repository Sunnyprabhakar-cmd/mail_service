CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  reply_to_email VARCHAR(320),
  template TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  import_status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (import_status IN ('queued', 'processing', 'completed', 'failed')),
  imported_count INT NOT NULL DEFAULT 0,
  invalid_count INT NOT NULL DEFAULT 0,
  import_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email VARCHAR(320) NOT NULL,
  name VARCHAR(255),
  company VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, email)
);

CREATE TABLE IF NOT EXISTS campaign_assets (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  cid VARCHAR(255) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, cid)
);

CREATE TABLE IF NOT EXISTS recipient_message_map (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  recipient_id BIGINT,
  recipient_email VARCHAR(320) NOT NULL,
  message_id VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipients_campaign_status ON recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_recipients_email ON recipients(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipients_campaign_email_lower_unique ON recipients(campaign_id, LOWER(email));
CREATE INDEX IF NOT EXISTS idx_campaign_assets_campaign_id ON campaign_assets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipient_message_map_campaign_id ON recipient_message_map(campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipient_message_map_recipient_email ON recipient_message_map(LOWER(recipient_email));
