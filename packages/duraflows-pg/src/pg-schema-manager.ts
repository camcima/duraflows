export type UuidStrategy = "uuidv7" | "gen_random_uuid";

export interface MigrationSqlOptions {
  uuidStrategy?: UuidStrategy;
}

/**
 * Generates the SQL migration script for the duraflows workflow tables.
 *
 * Use `uuidStrategy: "uuidv7"` for PostgreSQL 18+ (time-ordered UUIDs)
 * or `"gen_random_uuid"` for PostgreSQL 13+ (random UUIDs, the default).
 *
 * Copy the output into a dbmate migration file (or any other migration tool).
 */
export function generateMigrationSql(options?: MigrationSqlOptions): { up: string; down: string } {
  const uuidDefault = options?.uuidStrategy === "uuidv7" ? "uuidv7()" : "gen_random_uuid()";

  const up = `-- UUIDs for workflow_instances are generated application-side (randomUUID).
-- UUIDs for workflow_history are generated database-side (${uuidDefault}).

CREATE TABLE workflow_instances (
  uuid                uuid PRIMARY KEY,
  workflow_name       text NOT NULL,
  current_state       text NOT NULL,
  version             integer NOT NULL DEFAULT 0,
  definition_version  integer NULL,
  expires_at          timestamptz NULL,
  last_transition_at  timestamptz NOT NULL DEFAULT now(),
  context_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_instances_workflow_name_idx
  ON workflow_instances (workflow_name);

CREATE INDEX workflow_instances_expires_at_idx
  ON workflow_instances (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE workflow_history (
  uuid                    uuid PRIMARY KEY DEFAULT ${uuidDefault},
  workflow_instance_uuid  uuid NOT NULL
    REFERENCES workflow_instances(uuid),
  from_state              text,
  event_name              text NOT NULL,
  to_state                text NOT NULL,
  outcome                 text NOT NULL CHECK (outcome IN ('success', 'failure', 'guard-rejected')),
  error_message           text,
  rejected_by             text,
  command_results_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger_metadata_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  definition_version      integer NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_history_instance_created_idx
  ON workflow_history (workflow_instance_uuid, created_at DESC);

CREATE TABLE workflow_definitions (
  workflow_name    text NOT NULL,
  version          integer NOT NULL,
  content_hash     text NOT NULL,
  definition_json  jsonb NOT NULL,
  registered_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_name, version)
);`;

  const down = `DROP TABLE IF EXISTS workflow_definitions;
DROP TABLE IF EXISTS workflow_history;
DROP TABLE IF EXISTS workflow_instances;`;

  return { up, down };
}
