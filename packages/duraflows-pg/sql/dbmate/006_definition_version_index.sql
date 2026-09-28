-- migrate:up

-- Recommended, not required: keeps the runtime's startup executability check
-- and listDefinitionVersions() counts cheap on large tables. Idempotent, so
-- operators can pre-build it with CREATE INDEX CONCURRENTLY (same name and
-- definition) and this migration then skips it.
create index if not exists workflow_instances_definition_version_idx
  on workflow_instances (workflow_name, definition_version);

-- migrate:down

drop index if exists workflow_instances_definition_version_idx;
