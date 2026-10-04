import type { Pool, PoolClient } from "pg";
import type {
  WorkflowIdempotencyStore,
  WorkflowIdempotencyRecord,
  WorkflowIdempotencyReservation,
  WorkflowExecutionResult,
} from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

export class PgWorkflowIdempotencyStore implements WorkflowIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  private getClient(): PoolClient {
    const client = PgTransactionContext.getClient(this.pool);
    if (!client) throw new WorkflowError("WorkflowIdempotencyStore requires an active transaction");
    return client;
  }

  async find(workflowInstanceUuid: string, key: string): Promise<WorkflowIdempotencyRecord | null> {
    const { rows } = await this.getClient().query(
      "SELECT * FROM workflow_event_idempotency WHERE workflow_instance_uuid = $1 AND idempotency_key = $2",
      [workflowInstanceUuid, key],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      workflowInstanceUuid: row.workflow_instance_uuid as string,
      key: row.idempotency_key as string,
      eventName: row.event_name as string,
      fingerprint: (row.fingerprint as string | null) ?? undefined,
      result: row.result_json as WorkflowExecutionResult | null,
      createdAt: new Date(row.created_at as string),
    };
  }

  async reserve(input: WorkflowIdempotencyReservation): Promise<void> {
    await this.getClient().query(
      `INSERT INTO workflow_event_idempotency (workflow_instance_uuid, idempotency_key, event_name, fingerprint)
       VALUES ($1, $2, $3, $4)`,
      [input.workflowInstanceUuid, input.key, input.eventName, input.fingerprint ?? null],
    );
  }

  async complete(workflowInstanceUuid: string, key: string, result: WorkflowExecutionResult): Promise<void> {
    const { rowCount } = await this.getClient().query(
      `UPDATE workflow_event_idempotency SET result_json = $3
       WHERE workflow_instance_uuid = $1 AND idempotency_key = $2 AND result_json IS NULL`,
      [workflowInstanceUuid, key, JSON.stringify(result)],
    );
    if (rowCount !== 1) throw new WorkflowError("Idempotency reservation is missing or already completed");
  }
}
