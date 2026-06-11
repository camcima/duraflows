import type { Pool, PoolClient } from "pg";
import type { WorkflowHistoryStore, WorkflowHistoryRecord } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

export class PgWorkflowHistoryStore implements WorkflowHistoryStore {
  constructor(private readonly pool: Pool) {}

  private getClient(): PoolClient | Pool {
    return PgTransactionContext.getClient() ?? this.pool;
  }

  async append(entry: WorkflowHistoryRecord): Promise<string> {
    const client = this.getClient();
    const result = await client.query(
      `INSERT INTO workflow_history (
        workflow_instance_uuid, from_state, event_name, to_state,
        outcome, error_message, rejected_by, command_results_json,
        trigger_metadata_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING uuid`,
      [
        entry.workflowInstanceUuid,
        entry.fromState,
        entry.eventName,
        entry.toState,
        entry.outcome,
        entry.errorMessage ?? null,
        entry.rejectedBy ?? null,
        JSON.stringify(entry.commandResultsJson),
        JSON.stringify(entry.triggerMetadata ?? {}),
      ],
    );
    return result.rows[0].uuid as string;
  }

  async findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    const client = this.getClient();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const result = await client.query(
      `SELECT * FROM workflow_history
       WHERE workflow_instance_uuid = $1
       ORDER BY created_at DESC, uuid DESC
       LIMIT $2 OFFSET $3`,
      [workflowInstanceUuid, limit, offset],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      workflowInstanceUuid: row.workflow_instance_uuid as string,
      fromState: row.from_state as string | null,
      eventName: row.event_name as string,
      toState: row.to_state as string,
      outcome: row.outcome as "success" | "failure" | "guard-rejected",
      rejectedBy: (row.rejected_by as string | null) ?? undefined,
      errorMessage: (row.error_message as string | null) ?? undefined,
      commandResultsJson: row.command_results_json as WorkflowHistoryRecord["commandResultsJson"],
      triggerMetadata: row.trigger_metadata_json as Record<string, unknown> | undefined,
    }));
  }
}
