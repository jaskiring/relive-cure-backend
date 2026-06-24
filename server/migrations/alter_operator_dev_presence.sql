-- Operator Phase 2 — local Cursor bridge + CRM presence (founder logged in on Mac)

alter table operator_inbox
  add column if not exists approved_by text;

create table if not exists operator_dev_presence (
  username   text not null,
  source     text not null default 'crm',
  last_seen  timestamptz not null default now(),
  meta       jsonb,
  primary key (username, source)
);

create index if not exists operator_dev_presence_last_seen_idx
  on operator_dev_presence (last_seen desc);

revoke all on operator_dev_presence from anon, authenticated;
grant all on operator_dev_presence to service_role;
