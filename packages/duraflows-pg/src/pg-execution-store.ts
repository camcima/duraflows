import type { Pool, PoolClient } from "pg";
import type { DurableWorkflowExecution, WorkflowExecutionStore } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

export class PgWorkflowExecutionStore implements WorkflowExecutionStore {
  constructor(private readonly pool: Pool) {}
  private executor(write = false): Pool | PoolClient {
    const client = PgTransactionContext.getClient(this.pool);
    if (write && !client) throw new WorkflowError("WorkflowExecutionStore writes require an active transaction");
    return client ?? this.pool;
  }
  async create(e: DurableWorkflowExecution): Promise<void> {
    await this.executor(true).query(
      `INSERT INTO workflow_executions
      (uuid, workflow_instance_uuid, idempotency_key, status, available_at, lease_until, revision, execution_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.uuid,
        e.workflowInstanceUuid,
        e.idempotencyKey,
        e.status,
        e.availableAt,
        e.leaseUntil,
        e.revision,
        JSON.stringify(e),
      ],
    );
  }
  async update(e: DurableWorkflowExecution): Promise<void> {
    const result = await this.executor(true).query(
      `UPDATE workflow_executions SET status=$2, available_at=$3, lease_until=$4, revision=$5, execution_json=$6
      WHERE uuid=$1 AND revision=$7`,
      [e.uuid, e.status, e.availableAt, e.leaseUntil, e.revision, JSON.stringify(e), e.revision - 1],
    );
    if (result.rowCount !== 1) throw new WorkflowError("Durable execution revision conflict");
  }
  private async find(where: string, values: unknown[]): Promise<DurableWorkflowExecution | null> {
    const { rows } = await this.executor().query<{ execution_json: DurableWorkflowExecution }>(
      `SELECT execution_json FROM workflow_executions WHERE ${where}`,
      values,
    );
    return rows[0]?.execution_json ?? null;
  }
  async findByUuid(uuid: string): Promise<DurableWorkflowExecution | null> {
    return this.find("uuid=$1", [uuid]);
  }
  async findByKey(uuid: string, key: string): Promise<DurableWorkflowExecution | null> {
    return this.find("workflow_instance_uuid=$1 AND idempotency_key=$2", [uuid, key]);
  }
  async findActive(uuid: string): Promise<DurableWorkflowExecution | null> {
    return this.find("workflow_instance_uuid=$1 AND status IN ('pending','running','parked')", [uuid]);
  }
  async findDue(limit: number, now: Date): Promise<DurableWorkflowExecution[]> {
    const { rows } = await this.executor().query<{ execution_json: DurableWorkflowExecution }>(
      `SELECT execution_json FROM workflow_executions
      WHERE status IN ('pending','running') AND available_at <= $1 AND (lease_until IS NULL OR lease_until <= $1)
      ORDER BY available_at, uuid LIMIT $2`,
      [now, limit],
    );
    return rows.map((row) => row.execution_json);
  }
}
