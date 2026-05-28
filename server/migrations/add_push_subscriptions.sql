-- Phase M3: Web Push subscriptions for the mobile companion app
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint  text PRIMARY KEY,
  p256dh    text NOT NULL,
  auth      text NOT NULL,
  user_id   text,
  user_agent text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for cleanup queries (expired subs older than 90 days)
CREATE INDEX IF NOT EXISTS idx_push_subs_created
  ON push_subscriptions (created_at);
