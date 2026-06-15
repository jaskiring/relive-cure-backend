-- Auto-push config — single-row table controlling hands-free CRM push.
-- When enabled, the backend worker pushes new, quiet, qualified chatbot leads
-- to Refrens automatically and assigns each to a rep (optionally split between
-- two reps). Founder-controlled from the dashboard; survives restarts.
--
-- Run once in the Supabase SQL editor.

create table if not exists auto_push_config (
  id          int primary key default 1,
  enabled     boolean not null default false,
  enabled_at  timestamptz,                 -- when it was last turned ON; only leads created after this are auto-pushed
  rep_a       text,                        -- primary rep (required when enabled)
  rep_b       text,                        -- optional second rep for split
  split_a_pct int not null default 100,    -- % of leads to rep_a (rest to rep_b); 100 when single rep
  updated_by  text,
  updated_at  timestamptz default now(),
  constraint auto_push_singleton check (id = 1)
);

insert into auto_push_config (id, enabled) values (1, false)
  on conflict (id) do nothing;
