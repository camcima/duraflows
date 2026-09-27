-- migrate:up

-- Every statement is idempotent so operators of large tables can add the
-- columns and pre-build both indexes with CREATE INDEX CONCURRENTLY (same
-- names and definitions) before running this migration; it then skips them.
alter table workflow_instances
  add column if not exists timeout_attempts   integer     not null default 0,
  add column if not exists timeout_retry_at   timestamptz null,
  add column if not exists timeout_last_error text        null,
  add column if not exists timeout_parked_at  timestamptz null;

create index if not exists workflow_instances_timeout_due_idx
  on workflow_instances ((coalesce(timeout_retry_at, expires_at)))
  where expires_at is not null and timeout_parked_at is null;

create index if not exists workflow_instances_timeout_parked_idx
  on workflow_instances (timeout_parked_at)
  where timeout_parked_at is not null;

-- migrate:down

drop index if exists workflow_instances_timeout_parked_idx;
drop index if exists workflow_instances_timeout_due_idx;
alter table workflow_instances
  drop column timeout_parked_at,
  drop column timeout_last_error,
  drop column timeout_retry_at,
  drop column timeout_attempts;
