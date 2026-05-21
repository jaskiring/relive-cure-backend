-- Meta Ads integration — schema for credentials, campaigns, daily insights
-- Run this once in Supabase Studio → SQL editor (or `psql`)
-- Safe to re-run: every CREATE uses IF NOT EXISTS.

-- ─── meta_credentials ────────────────────────────────────────────────────────
-- One row per business. Token is AES-256-GCM encrypted server-side; the raw
-- token is never written to the browser and never logged.
CREATE TABLE IF NOT EXISTS meta_credentials (
  id              text        PRIMARY KEY DEFAULT 'default',
  token_encrypted text        NOT NULL,    -- format: <iv_hex>:<ciphertext_hex>:<tag_hex>
  ad_account_id   text        NOT NULL,    -- e.g. "act_1506354983886720"
  account_name    text,                    -- cached from Graph API
  business_id     text,                    -- cached from Graph API
  last_sync_at    timestamptz,
  last_sync_status text,                   -- 'ok' | 'error: <msg>'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

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

-- ─── trigger to keep meta_credentials.updated_at fresh ──────────────────────
CREATE OR REPLACE FUNCTION meta_credentials_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meta_credentials_touch ON meta_credentials;
CREATE TRIGGER meta_credentials_touch
  BEFORE UPDATE ON meta_credentials
  FOR EACH ROW EXECUTE FUNCTION meta_credentials_touch_updated_at();
