-- Agent on/off switches for Marketing · Organic command center.

CREATE TABLE IF NOT EXISTS agent_jobs (
  id           BIGSERIAL   PRIMARY KEY,
  agent_key    TEXT        NOT NULL UNIQUE,
  label        TEXT        NOT NULL,
  description  TEXT,
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  config       JSONB       NOT NULL DEFAULT '{}',
  last_run_at  TIMESTAMPTZ,
  last_status  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agent_jobs (agent_key, label, description, enabled) VALUES
  ('screenshot_parser', 'Screenshot parser', 'M4 overnight: IG/FB screenshots → Gemini → organic_leads', true),
  ('trend_scout',       'Trend scout',       'Weekly reel/post ideas from CRM objections + Meta insights', false),
  ('comment_engager',   'Comment engager',   'Template replies on IG/FB comments (manual send v0)', false),
  ('dm_qualifier',      'DM qualifier',      'Ask @user for phone or WA bot link', false),
  ('re_engage',         'Re-engage',         'Deal Done 6–24mo → referral outreach list', false)
ON CONFLICT (agent_key) DO NOTHING;

ALTER TABLE agent_jobs DISABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE agent_jobs
  TO service_role, authenticated, anon, postgres;

GRANT USAGE, SELECT ON SEQUENCE agent_jobs_id_seq
  TO service_role, authenticated, anon, postgres;
