import type { ColumnType, Generated } from "kysely";

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
