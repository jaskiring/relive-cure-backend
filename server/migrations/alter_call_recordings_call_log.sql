-- Call log dedup + recording linkage for full history sync from rep app.
-- Idempotent — safe to re-run.

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS call_log_id TEXT,
  ADD COLUMN IF NOT EXISTS call_type TEXT,
  ADD COLUMN IF NOT EXISTS has_recording BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_rep_call_log
  ON call_recordings (rep_id, call_log_id)
  WHERE call_log_id IS NOT NULL AND rep_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_call_recordings_phone_started
  ON call_recordings (phone, call_started_at DESC);

COMMENT ON COLUMN call_recordings.call_log_id IS 'Android CallLog._ID — dedup key per rep device';
COMMENT ON COLUMN call_recordings.call_type IS 'incoming | outgoing | missed | rejected | voicemail | unknown';
COMMENT ON COLUMN call_recordings.has_recording IS 'True once OEM audio uploaded and linked to this call row';
