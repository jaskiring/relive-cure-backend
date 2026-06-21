-- Settings v2: designation + per-tab access
-- Run once in Supabase SQL editor after create_dashboard_users.sql

ALTER TABLE dashboard_users
  ADD COLUMN IF NOT EXISTS designation TEXT,
  ADD COLUMN IF NOT EXISTS allowed_tabs TEXT[] NOT NULL DEFAULT '{}';

-- Backfill existing rows from role
UPDATE dashboard_users SET allowed_tabs = CASE role
  WHEN 'admin'   THEN ARRAY['pulse','chatbot','inbox','analytics','marketing','hr','settings']
  WHEN 'limited' THEN ARRAY['chatbot','hr']
  WHEN 'rep'     THEN ARRAY['chatbot','inbox']
  WHEN 'hr'      THEN ARRAY['hr']
  ELSE ARRAY['chatbot']
END
WHERE allowed_tabs = '{}';
