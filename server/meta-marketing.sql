-- Meta Ads integration — schema for synced campaign + insights data
-- Run this once in Supabase Studio → SQL editor (or `psql`)
-- Safe to re-run: every CREATE uses IF NOT EXISTS.
--
-- Credentials (System User token + ad account ID) live in Railway env vars:
--   META_ACCESS_TOKEN
--   META_AD_ACCOUNT_ID    (e.g. "act_1506354983886720" or bare digits)
-- They are NEVER stored in this database.

-- ─── meta_campaigns ──────────────────────────────────────────────────────────
-- One row per Meta ad campaign. Mirrors what the Graph API returns.
CREATE TABLE IF NOT EXISTS meta_campaigns (
  id              text        PRIMARY KEY,           -- campaign_id from Meta
  account_id      text        NOT NULL,              -- "act_…"
  name            text        NOT NULL,
  objective       text,
  status          text,                              -- ACTIVE / PAUSED / DELETED
  daily_budget    numeric,                           -- in account currency, minor units / 100
  lifetime_budget numeric,
  start_time      timestamptz,
  stop_time       timestamptz,
  last_synced_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_campaigns_account_idx ON meta_campaigns(account_id);
CREATE INDEX IF NOT EXISTS meta_campaigns_status_idx  ON meta_campaigns(status);
CREATE INDEX IF NOT EXISTS meta_campaigns_synced_idx  ON meta_campaigns(last_synced_at DESC);

-- ─── meta_ad_insights ────────────────────────────────────────────────────────
-- Daily roll-up of spend / impressions / clicks / leads per campaign.
-- Composite PK (campaign_id, date) means upserts on re-sync replace the day.
CREATE TABLE IF NOT EXISTS meta_ad_insights (
  campaign_id     text        NOT NULL,
  date            date        NOT NULL,
  spend           numeric     NOT NULL DEFAULT 0,
  impressions     integer     NOT NULL DEFAULT 0,
  clicks          integer     NOT NULL DEFAULT 0,
  leads           integer     NOT NULL DEFAULT 0,    -- on-platform lead-form submits
  reach           integer,
  cpm             numeric,
  cpc             numeric,
  ctr             numeric,
  last_synced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, date)
);

CREATE INDEX IF NOT EXISTS meta_ad_insights_date_idx ON meta_ad_insights(date DESC);

-- ─── meta_leads ──────────────────────────────────────────────────────────────
-- One row per Facebook Lead Form submission. Captured via the Meta Page
-- leadgen webhook (object: page, field: leadgen). Phone is normalized so we
-- can match back to refrens_leads / leads_surgery by phone.
CREATE TABLE IF NOT EXISTS meta_leads (
  meta_lead_id     text        PRIMARY KEY,
  page_id          text,
  form_id          text,
  ad_id            text,
  adgroup_id       text,                      -- Meta calls this adset_id
  campaign_id      text,
  created_time     timestamptz,
  phone            text,                      -- normalized digits, e.g. "9892520668"
  name             text,
  email            text,
  city             text,
  field_data       jsonb,                     -- full form payload from Meta
  matched_lead_id  text,                      -- FK to refrens_leads.id or leads_surgery.id once matched
  matched_source   text,                      -- 'refrens' | 'chatbot' | null
  raw_payload      jsonb,                     -- complete Meta webhook payload (for debugging)
  inserted_at      timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meta_leads_phone_idx     ON meta_leads(phone);
CREATE INDEX IF NOT EXISTS meta_leads_campaign_idx  ON meta_leads(campaign_id);
CREATE INDEX IF NOT EXISTS meta_leads_form_idx      ON meta_leads(form_id);
CREATE INDEX IF NOT EXISTS meta_leads_created_idx   ON meta_leads(created_time DESC);

ALTER TABLE meta_leads DISABLE ROW LEVEL SECURITY;
GRANT ALL ON meta_leads TO service_role, authenticated, anon;

-- ─── Cleanup (optional) ──────────────────────────────────────────────────────
-- If you ran the previous version of this SQL, the old meta_credentials table
-- can be dropped. Uncomment to clean up:
--   DROP TABLE IF EXISTS meta_credentials CASCADE;
