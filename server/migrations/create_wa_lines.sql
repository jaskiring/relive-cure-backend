-- Multi-line WhatsApp: bot (Cloud API) + rep lines (WA Web bridge on M4).
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS wa_lines (
  id              TEXT        PRIMARY KEY,
  label           TEXT        NOT NULL,
  kind            TEXT        NOT NULL DEFAULT 'rep',  -- 'bot' | 'rep'
  rep_id          TEXT,
  phone_display   TEXT,
  bridge_status   TEXT        NOT NULL DEFAULT 'disconnected',  -- disconnected | qr_pending | connected
  qr_data_url     TEXT,
  qr_updated_at   TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO wa_lines (id, label, kind, bridge_status)
VALUES ('bot', 'WhatsApp Bot (Cloud API)', 'bot', 'connected')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS wa_line_id TEXT NOT NULL DEFAULT 'bot';

ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS wa_line_id TEXT NOT NULL DEFAULT 'bot';

CREATE INDEX IF NOT EXISTS ix_whatsapp_messages_line_phone
  ON whatsapp_messages (wa_line_id, phone, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_whatsapp_conversations_line
  ON whatsapp_conversations (wa_line_id, last_message_at DESC);

ALTER TABLE wa_lines DISABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE wa_lines
  TO service_role, authenticated, anon, postgres;
