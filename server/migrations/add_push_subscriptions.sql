-- Phase M3: Web Push subscriptions for the mobile + desktop dashboards.
-- Idempotent — every statement is safe to re-run.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   text PRIMARY KEY,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  user_id    text,
  user_agent text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for cleanup queries (expired subs older than 90 days)
CREATE INDEX IF NOT EXISTS idx_push_subs_created
  ON push_subscriptions (created_at);

-- Only the backend touches this table (via supabaseAdmin's service_role
-- key). Disable RLS — there are no client-side reads or writes that
-- need row-level checks.
ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;

-- Explicit grants so newer Supabase setups (which restrict default
-- public-schema permissions) don't trip with "permission denied for
-- table push_subscriptions" when the backend tries to insert.
GRANT ALL PRIVILEGES ON TABLE push_subscriptions
  TO service_role, authenticated, anon, postgres;
