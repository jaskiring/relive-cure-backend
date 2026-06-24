-- Organic social leads (IG/FB comments, DMs) from screenshot parser or manual entry.

CREATE TABLE IF NOT EXISTS organic_leads (
  id               BIGSERIAL   PRIMARY KEY,
  platform         TEXT        NOT NULL,  -- instagram | facebook | whatsapp
  username         TEXT,
  display_name     TEXT,
  raw_text         TEXT,
  post_hint        TEXT,
  status           TEXT        NOT NULL DEFAULT 'new',  -- new | contacted | converted | dismissed
  phone            TEXT,
  screenshot_path  TEXT,
  parsed_at        TIMESTAMPTZ,
  contacted_at     TIMESTAMPTZ,
  assigned_rep     TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_organic_leads_status_created
  ON organic_leads (status, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_organic_leads_username
  ON organic_leads (platform, username);

ALTER TABLE organic_leads DISABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE organic_leads
  TO service_role, authenticated, anon, postgres;

GRANT USAGE, SELECT ON SEQUENCE organic_leads_id_seq
  TO service_role, authenticated, anon, postgres;
