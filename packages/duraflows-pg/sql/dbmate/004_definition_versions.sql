-- migrate:up

create table workflow_definitions (
  workflow_name    text not null,
  version          integer not null,
  content_hash     text not null,
  definition_json  jsonb not null,
  registered_at    timestamptz not null default now(),
  primary key (workflow_name, version)
);

alter table workflow_instances
  add column definition_version integer null;

alter table workflow_history
  add column definition_version integer null;

-- migrate:down

alter table workflow_history drop column definition_version;
alter table workflow_instances drop column definition_version;
drop table if exists workflow_definitions;
