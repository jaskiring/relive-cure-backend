-- Add Refrens deep-link columns to leads_surgery.
-- Idempotent: safe to re-run. Nullable so existing rows continue to work.
ALTER TABLE leads_surgery
  ADD COLUMN IF NOT EXISTS refrens_lead_url text,
  ADD COLUMN IF NOT EXISTS refrens_lead_id  text;

-- Optional index — fast lookup of "is this lead in Refrens yet?"
CREATE INDEX IF NOT EXISTS idx_leads_surgery_refrens_id
  ON leads_surgery (refrens_lead_id)
  WHERE refrens_lead_id IS NOT NULL;
