-- Operator S2 — dev_route column (opencode | cursor)

alter table operator_inbox
  add column if not exists dev_route text;

create index if not exists operator_inbox_dev_route_idx
  on operator_inbox (dev_route, dev_status)
  where status = 'approved';
