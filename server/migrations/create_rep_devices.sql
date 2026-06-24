-- Rep phones fleet registry: remote recording path, setup status, heartbeats.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS rep_devices (
  device_id              TEXT        PRIMARY KEY,
  rep_id                 TEXT,
  rep_name               TEXT,
  device_label           TEXT,
  manufacturer           TEXT,
  device_model           TEXT,
  android_sdk            INT,
  app_version            TEXT,
  recording_path         TEXT,        -- admin-set path (dashboard)
  recording_path_local   TEXT,        -- effective path app is using
  paths_watching         JSONB       NOT NULL DEFAULT '[]',
  google_account         TEXT,
  upload_target          TEXT        NOT NULL DEFAULT 'supabase',
  setup_status           TEXT        NOT NULL DEFAULT 'pending',
  -- pending | path_missing | path_set | ready | offline
  permissions            JSONB       NOT NULL DEFAULT '{}',
  last_heartbeat_at      TIMESTAMPTZ,
  last_upload_ok_at      TIMESTAMPTZ,
  last_call_at           TIMESTAMPTZ,
  notes                  TEXT,
  metadata               JSONB       NOT NULL DEFAULT '{}',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_rep_devices_rep ON rep_devices (rep_id, last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS ix_rep_devices_status ON rep_devices (setup_status, last_heartbeat_at DESC);

ALTER TABLE rep_devices DISABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE rep_devices TO service_role, authenticated, anon, postgres;
