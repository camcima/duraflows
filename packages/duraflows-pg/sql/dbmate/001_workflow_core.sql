-- migrate:up

-- UUIDs are generated application-side (node:crypto randomUUID).
-- No DB-side default: the application always supplies the uuid on INSERT.

create table workflow_instances (
  uuid                uuid primary key,
  workflow_name       text not null,
  current_state       text not null,
  version             integer not null default 0,
  expires_at          timestamptz null,
  last_transition_at  timestamptz not null default now(),
  context_json        jsonb not null default '{}'::jsonb,
  metadata_json       jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index workflow_instances_workflow_name_idx
  on workflow_instances (workflow_name);

create index workflow_instances_expires_at_idx
  on workflow_instances (expires_at)
  where expires_at is not null;

create table workflow_history (
  uuid                    uuid primary key default gen_random_uuid(),
  workflow_instance_uuid  uuid not null
    references workflow_instances(uuid),
  from_state              text,
  event_name              text not null,
  to_state                text not null,
  outcome                 text not null check (outcome in ('success', 'failure')),
  error_message           text,
  command_results_json    jsonb not null default '[]'::jsonb,
  triggered_by_type       text,
  triggered_by_uuid       uuid null,
  created_at              timestamptz not null default now()
);

create index workflow_history_instance_created_idx
  on workflow_history (workflow_instance_uuid, created_at desc);

-- migrate:down

drop table if exists workflow_history;
drop table if exists workflow_instances;
