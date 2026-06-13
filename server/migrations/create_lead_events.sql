-- Phase 1 Day 2: lead_events append-only timeline table.
-- Every event in a lead's "lore" lands here: WhatsApp messages, bot signals,
-- CRM pushes, call recordings, transcription results, extracted insights.
--
-- Access patterns:
--   • Per-lead timeline:  WHERE phone = ? ORDER BY ts DESC
--   • Signal monitoring:  WHERE event_type = ? ORDER BY ts DESC
--
-- Idempotent — all statements are safe to re-run.

CREATE TABLE IF NOT EXISTS lead_events (
  id          BIGSERIAL   PRIMARY KEY,
  phone       TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Vocabulary: 'whatsapp_in' | 'whatsapp_out' | 'bot_signal' | 'crm_pushed'
  --             | 'call_recorded' | 'call_transcribed' | 'insights_extracted'
  --             | 'label_changed' | 'status_changed'
  event_type  TEXT        NOT NULL,

  -- Who produced this event: 'customer' | 'bot' | 'rep' | 'system' | 'lore_engine'
  source      TEXT        NOT NULL DEFAULT 'system',

  -- Arbitrary per-event data (message body, call duration, insight fields, etc.)
  payload     JSONB       NOT NULL DEFAULT '{}',

  -- Dedup key: backfill re-runs are safe — second run is a complete no-op.
  UNIQUE (phone, ts, event_type)
);

-- Timeline reads: all events for one lead, newest first.
CREATE INDEX IF NOT EXISTS ix_lead_events_phone_ts
  ON lead_events (phone, ts DESC);

-- Signal monitoring: find the freshest events of a given type across all leads.
CREATE INDEX IF NOT EXISTS ix_lead_events_type_ts
  ON lead_events (event_type, ts DESC);

-- Only backend service-role writes to this table during Phase 1.
-- RLS off keeps queries fast. Re-enable if you open client-side reads later.
ALTER TABLE lead_events DISABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE lead_events
  TO service_role, authenticated, anon, postgres;

GRANT USAGE, SELECT ON SEQUENCE lead_events_id_seq
  TO service_role, authenticated, anon, postgres;
