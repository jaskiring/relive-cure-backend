-- Dashboard users table for role-based access control
-- Run once in Supabase SQL editor
CREATE TABLE IF NOT EXISTS dashboard_users (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'limited'
                    CHECK (role IN ('admin', 'limited', 'hr', 'rep')),
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Disable RLS — accessed only via service role key from backend
ALTER TABLE dashboard_users DISABLE ROW LEVEL SECURITY;
