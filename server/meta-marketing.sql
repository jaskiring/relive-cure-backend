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

-- ─── Cleanup (optional) ──────────────────────────────────────────────────────
-- If you ran the previous version of this SQL, the old meta_credentials table
-- can be dropped. Uncomment to clean up:
--   DROP TABLE IF EXISTS meta_credentials CASCADE;
