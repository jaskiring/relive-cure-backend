-- lead_signals: material changes detected on bot lead upsert (diff-on-upsert in ingestion.js).
-- Append-only. Dedup is handled at application level (detectSignals() only fires on actual deltas).

CREATE TABLE IF NOT EXISTS public.lead_signals (
  id           BIGSERIAL PRIMARY KEY,
  phone        TEXT        NOT NULL,
  signal_type  TEXT        NOT NULL,  -- see SIGNAL_TYPES in enums.js
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  old_value    TEXT,
  new_value    TEXT,
  payload      JSONB       NOT NULL DEFAULT '{}'
);

-- Query patterns: by phone (timeline), by type+time (fanout queue).
CREATE INDEX IF NOT EXISTS ix_lead_signals_phone_time
  ON public.lead_signals (phone, detected_at DESC);

CREATE INDEX IF NOT EXISTS ix_lead_signals_type_time
  ON public.lead_signals (signal_type, detected_at DESC);

-- RLS off — service-role writes, anon reads via dashboard.
ALTER TABLE public.lead_signals DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.lead_signals TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.lead_signals_id_seq TO anon, authenticated, service_role;
