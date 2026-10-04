import type { ColumnType, Generated } from "kysely";
import type { WorkflowExecutionResult } from "@duraflows/core";

/**
 * JSON column type that accepts Record<string, unknown> in TS
 * but is stored as JSONB in PostgreSQL.
 *
 * - Select: returns parsed object
 * - Insert: accepts string (caller uses JSON.stringify)
 * - Update: accepts string (caller uses JSON.stringify)
 */
type JsonObjectColumn = ColumnType<Record<string, unknown>, string, string>;

/**
 * JSON array column type for command_results_json.
 */
type JsonArrayColumn = ColumnType<Record<string, unknown>[], string, string>;

export interface WorkflowInstancesTable {
  uuid: string;
  workflow_name: string;
  current_state: string;
  version: number;
  definition_version: number | null;
  expires_at: Date | null;
  last_transition_at: Date;
  context_json: JsonObjectColumn;
  metadata_json: JsonObjectColumn;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  timeout_attempts: Generated<number>;
  timeout_retry_at: Date | null;
  timeout_last_error: string | null;
  timeout_parked_at: Date | null;
}

export interface WorkflowHistoryTable {
  uuid: Generated<string>;
  workflow_instance_uuid: string;
  from_state: string | null;
  event_name: string;
  to_state: string;
  outcome: string;
  error_message: string | null;
  rejected_by: string | null;
  command_results_json: JsonArrayColumn;
  trigger_metadata_json: JsonObjectColumn;
  definition_version: number | null;
  created_at: Generated<Date>;
}

export interface WorkflowDefinitionsTable {
  workflow_name: string;
  version: number;
  content_hash: string;
  definition_json: JsonObjectColumn;
  registered_at: Generated<Date>;
}

export interface WorkflowDatabase {
  workflow_instances: WorkflowInstancesTable;
  workflow_history: WorkflowHistoryTable;
  workflow_definitions: WorkflowDefinitionsTable;
}

export interface WorkflowEventIdempotencyTable {
  workflow_instance_uuid: string;
  idempotency_key: string;
  event_name: string;
  fingerprint: string | null;
  result_json: ColumnType<WorkflowExecutionResult | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}

/** Optional extension; existing WorkflowDatabase consumers need no new required table. */
export interface WorkflowDatabaseWithIdempotency extends WorkflowDatabase {
  workflow_event_idempotency: WorkflowEventIdempotencyTable;
}
