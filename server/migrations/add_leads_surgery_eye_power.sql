-- Add eye power columns used by bot ingest (safe to run multiple times).
ALTER TABLE public.leads_surgery
  ADD COLUMN IF NOT EXISTS eye_power text,
  ADD COLUMN IF NOT EXISTS eye_power_numeric numeric;
