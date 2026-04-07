CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipients_campaign_status ON recipients(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_recipients_email ON recipients(email);
