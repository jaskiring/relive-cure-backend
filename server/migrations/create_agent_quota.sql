-- Agent free-tier quota counter. Survives Railway redeploys (filesystem is
-- ephemeral; the counter must live in Supabase). One row per UTC day.
--
-- Run once in the Supabase SQL editor.

create table if not exists agent_quota (
  date          date primary key,
  request_count integer not null default 0,
  fallback_count integer not null default 0,
  tokens_prompt   integer not null default 0,
  tokens_output   integer not null default 0,
  tokens_thinking integer not null default 0,
  tokens_total    integer not null default 0,
  updated_at    timestamptz not null default now()
);

-- Helpful view: today's usage
create or replace view agent_quota_today as
select date, request_count, fallback_count
from agent_quota
order by date desc
limit 1;

-- Backend upserts via service_role (see grant_agent_quota_service_role.sql)
GRANT ALL ON TABLE public.agent_quota TO service_role;
REVOKE ALL ON TABLE public.agent_quota FROM anon;
REVOKE ALL ON TABLE public.agent_quota FROM authenticated;
