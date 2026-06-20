-- Agent free-tier quota counter. Survives Railway redeploys (filesystem is
-- ephemeral; the counter must live in Supabase). One row per UTC day.
--
-- Run once in the Supabase SQL editor.

create table if not exists agent_quota (
  date          date primary key,
  request_count integer not null default 0,
  fallback_count integer not null default 0,   -- times agent failed and rule-based fired
  updated_at    timestamptz not null default now()
);

-- Helpful view: today's usage
create or replace view agent_quota_today as
select date, request_count, fallback_count
from agent_quota
order by date desc
limit 1;
