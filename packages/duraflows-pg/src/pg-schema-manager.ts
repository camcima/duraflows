export type UuidStrategy = "uuidv7" | "gen_random_uuid";

export interface MigrationSqlOptions {
  /** Include the optional durable-execution table. Default false. */
  includeDurableExecution?: boolean;
  uuidStrategy?: UuidStrategy;
  /** Include the optional event-idempotency table in a fresh schema. Default false. */
  includeIdempotency?: boolean;
}

/** Additive migration; required only when enabling event idempotency. */
export function generateIdempotencyMigrationSql(): { up: string; down: string } {
  return {
    up: `CREATE TABLE workflow_event_idempotency (
  workflow_instance_uuid uuid NOT NULL REFERENCES workflow_instances(uuid) ON DELETE CASCADE,
  idempotency_key text COLLATE "C" NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  event_name text NOT NULL,
  fingerprint text COLLATE "C" NULL CHECK (fingerprint IS NULL OR octet_length(fingerprint) BETWEEN 1 AND 256),
  result_json jsonb NULL CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_instance_uuid, idempotency_key)
);`,
    down: "DROP TABLE IF EXISTS workflow_event_idempotency;",
  };
}

/**
 * Generates the SQL migration script for the duraflows workflow tables.
 *
 * Use `uuidStrategy: "uuidv7"` for PostgreSQL 18+ (time-ordered UUIDs)
 * or `"gen_random_uuid"` for PostgreSQL 13+ (random UUIDs, the default).
 *
 * This is not just a version preference: `workflow_history` reads are
 * ordered `created_at DESC, uuid DESC`, and every row written inside one
 * transaction (an event plus its entire `onEnter` chain) shares an
 * identical `created_at` because PostgreSQL's `now()` is transaction-scoped
 * -- so `uuid` is the only tiebreaker. `"uuidv7"` makes that tiebreak
 * monotonic, so a multi-hop transition reads back in the order it
 * happened; `"gen_random_uuid"` makes it arbitrary (though stable once
 * written). On PostgreSQL 13-17, `"uuidv7"` is unavailable, so that
 * ordering is simply not recoverable there. See docs/persistence.md for
 * the full explanation, including a verified empirical example. Note the
 * shipped dbmate migration (`sql/dbmate/001_workflow_core.sql`) hard-codes
 * `gen_random_uuid()` -- use this function instead if you need `uuidv7`.
 *
 * Copy the output into a dbmate migration file (or any other migration tool).
 */
export function generateMigrationSql(options?: MigrationSqlOptions): { up: string; down: string } {
  const uuidDefault = options?.uuidStrategy === "uuidv7" ? "uuidv7()" : "gen_random_uuid()";

  let up = `-- UUIDs for workflow_instances are generated application-side (randomUUID).
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
  updated_at          timestamptz NOT NULL DEFAULT now(),
  timeout_attempts    integer NOT NULL DEFAULT 0,
  timeout_retry_at    timestamptz NULL,
  timeout_last_error  text NULL,
  timeout_parked_at   timestamptz NULL
);

CREATE INDEX workflow_instances_workflow_name_idx
  ON workflow_instances (workflow_name);

CREATE INDEX workflow_instances_expires_at_idx
  ON workflow_instances (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX workflow_instances_timeout_due_idx
  ON workflow_instances ((coalesce(timeout_retry_at, expires_at)))
  WHERE expires_at IS NOT NULL AND timeout_parked_at IS NULL;

CREATE INDEX workflow_instances_timeout_parked_idx
  ON workflow_instances (timeout_parked_at)
  WHERE timeout_parked_at IS NOT NULL;

CREATE INDEX workflow_instances_definition_version_idx
  ON workflow_instances (workflow_name, definition_version);

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

  if (options?.includeIdempotency) up += `\n\n${generateIdempotencyMigrationSql().up}`;

  if (options?.includeDurableExecution) up += `\n\n${generateDurableExecutionMigrationSql().up}`;

  const down = `${options?.includeDurableExecution ? `${generateDurableExecutionMigrationSql().down}\n` : ""}${options?.includeIdempotency ? `${generateIdempotencyMigrationSql().down}\n` : ""}DROP TABLE IF EXISTS workflow_definitions;
DROP TABLE IF EXISTS workflow_history;
DROP TABLE IF EXISTS workflow_instances;`;

  return { up, down };
}

/** Optional additive schema for durable execution. */
export function generateDurableExecutionMigrationSql(): { up: string; down: string } {
  return {
    up: `CREATE TABLE workflow_executions (
  uuid uuid PRIMARY KEY,
  workflow_instance_uuid uuid NOT NULL REFERENCES workflow_instances(uuid) ON DELETE CASCADE,
  idempotency_key text COLLATE "C" NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status IN ('pending','running','parked','completed','cancelled')),
  available_at timestamptz NOT NULL,
  lease_until timestamptz NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  execution_json jsonb NOT NULL CHECK (jsonb_typeof(execution_json) = 'object'),
  UNIQUE (workflow_instance_uuid, idempotency_key)
);
CREATE UNIQUE INDEX workflow_executions_active_idx ON workflow_executions (workflow_instance_uuid)
  WHERE status IN ('pending','running','parked');
CREATE INDEX workflow_executions_due_idx ON workflow_executions (available_at, uuid)
  WHERE status IN ('pending','running');`,
    down: "DROP TABLE IF EXISTS workflow_executions;",
  };
}
