-- Split Gemini usage: WhatsApp bot vs CRM Operator (separate app caps).
-- Run once in Supabase SQL editor.

alter table public.agent_quota
  add column if not exists operator_request_count integer not null default 0,
  add column if not exists operator_fallback_count integer not null default 0,
  add column if not exists operator_tokens_total integer not null default 0,
  add column if not exists transcribe_request_count integer not null default 0,
  add column if not exists transcribe_tokens_total integer not null default 0,
  add column if not exists model_usage_json jsonb not null default '{}'::jsonb;

create table if not exists operator_inbox (
  id              bigserial primary key,
  username        text not null,
  role            text not null default 'limited',
  designation     text,
  message         text not null,
  transcript      text,
  kind            text not null default 'question',
  status          text not null default 'answered',
  reply           text,
  tool_data       jsonb,
  model_used      text,
  needs_founder   boolean not null default false,
  edited_prompt   text,
  dev_status      text,
  dev_result      jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists operator_inbox_needs_founder_idx
  on operator_inbox (needs_founder, created_at desc)
  where needs_founder = true;

create index if not exists operator_inbox_username_idx
  on operator_inbox (username, created_at desc);

grant all on table public.operator_inbox to service_role;
grant usage, select on sequence operator_inbox_id_seq to service_role;
revoke all on table public.operator_inbox from anon;
revoke all on table public.operator_inbox from authenticated;
