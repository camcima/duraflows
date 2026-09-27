-- migrate:up

alter table workflow_instances
  add column timeout_attempts   integer     not null default 0,
  add column timeout_retry_at   timestamptz null,
  add column timeout_last_error text        null,
  add column timeout_parked_at  timestamptz null;

create index workflow_instances_timeout_due_idx
  on workflow_instances ((coalesce(timeout_retry_at, expires_at)))
  where expires_at is not null and timeout_parked_at is null;

create index workflow_instances_timeout_parked_idx
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
