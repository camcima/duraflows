import type { Pool, PoolClient } from "pg";
import type { WorkflowInstanceStore, WorkflowInstance, WorkflowTimeoutRetry } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

/** The four timeout-retry column values for `retry`, in column order (`null` ⇒ never failed). */
function timeoutRetryParams(retry: WorkflowTimeoutRetry | null): [number, Date | null, string | null, Date | null] {
  return [retry?.attempts ?? 0, retry?.retryAt ?? null, retry?.lastError ?? null, retry?.parkedAt ?? null];
}

function mapTimeoutRetry(row: Record<string, unknown>): WorkflowTimeoutRetry | null {
  const attempts = (row.timeout_attempts as number | null | undefined) ?? 0;
  if (attempts === 0) return null;
  return {
    attempts,
    lastError: (row.timeout_last_error as string | null | undefined) ?? "",
    retryAt: row.timeout_retry_at ? new Date(row.timeout_retry_at as string) : null,
    parkedAt: row.timeout_parked_at ? new Date(row.timeout_parked_at as string) : null,
  };
}

export class PgWorkflowInstanceStore implements WorkflowInstanceStore {
  constructor(private readonly pool: Pool) {}

  private getClient(): PoolClient | Pool {
    return PgTransactionContext.getClient(this.pool) ?? this.pool;
  }

  async create(instance: WorkflowInstance): Promise<void> {
    const client = this.getClient();
    await client.query(
      `INSERT INTO workflow_instances (
        uuid, workflow_name, current_state, version, expires_at,
        last_transition_at, context_json, metadata_json,
        created_at, updated_at, definition_version,
        timeout_attempts, timeout_retry_at, timeout_last_error, timeout_parked_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        instance.uuid,
        instance.workflowName,
        instance.currentState,
        instance.version,
        instance.expiresAt,
        instance.lastTransitionAt,
        JSON.stringify(instance.context),
        JSON.stringify(instance.metadata),
        instance.createdAt,
        instance.updatedAt,
        instance.definitionVersion,
        ...timeoutRetryParams(instance.timeoutRetry),
      ],
    );
  }

  async findByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const client = this.getClient();
    const result = await client.query("SELECT * FROM workflow_instances WHERE uuid = $1", [uuid]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async lockByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const client = PgTransactionContext.getClient(this.pool);
    if (!client) {
      throw new WorkflowError("lockByUuid requires an active transaction");
    }
    const result = await client.query("SELECT * FROM workflow_instances WHERE uuid = $1 FOR UPDATE", [uuid]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async update(instance: WorkflowInstance): Promise<void> {
    const client = this.getClient();
    const expectedVersion = instance.version - 1;
    const result = await client.query(
      `UPDATE workflow_instances SET
        current_state = $2,
        version = $3,
        expires_at = $4,
        last_transition_at = $5,
        context_json = $6,
        updated_at = $7,
        definition_version = $8,
        timeout_attempts = $9,
        timeout_retry_at = $10,
        timeout_last_error = $11,
        timeout_parked_at = $12
      WHERE uuid = $1 AND version = $13`,
      [
        instance.uuid,
        instance.currentState,
        instance.version,
        instance.expiresAt,
        instance.lastTransitionAt,
        JSON.stringify(instance.context),
        instance.updatedAt,
        instance.definitionVersion,
        ...timeoutRetryParams(instance.timeoutRetry),
        expectedVersion,
      ],
    );
    if (result.rowCount === 0) {
      throw new WorkflowError(
        `Optimistic locking failure: workflow instance "${instance.uuid}" was modified concurrently (expected version ${expectedVersion})`,
      );
    }
  }

  async findExpired(limit: number, now: Date): Promise<WorkflowInstance[]> {
    const client = PgTransactionContext.getClient(this.pool);
    if (!client) {
      throw new WorkflowError("findExpired requires an active transaction");
    }
    const result = await client.query(
      `SELECT * FROM workflow_instances
       WHERE expires_at IS NOT NULL AND expires_at < $2
         AND timeout_parked_at IS NULL
         AND (timeout_retry_at IS NULL OR timeout_retry_at < $2)
         -- Redundant (every due row already satisfies it); it gives the planner
         -- a range condition so workflow_instances_timeout_due_idx is range-scanned
         -- instead of walked in order with every entry filtered against the heap.
         AND coalesce(timeout_retry_at, expires_at) < $2
       ORDER BY coalesce(timeout_retry_at, expires_at)
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit, now],
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  async findParkedTimeouts(options: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]> {
    const client = this.getClient();
    const result = await client.query(
      `SELECT * FROM workflow_instances
       WHERE timeout_parked_at IS NOT NULL
         AND ($2::text IS NULL OR workflow_name = $2)
       ORDER BY timeout_parked_at, uuid
       LIMIT $1`,
      [options.limit, options.workflowName ?? null],
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  async countInstances(options: {
    workflowName: string;
    definitionVersion: number;
    excludeStates: readonly string[];
  }): Promise<number> {
    const client = this.getClient();
    // With an empty array, `NOT (x = ANY('{}'))` is true, so nothing is excluded.
    const result = await client.query(
      `SELECT count(*)::int AS count FROM workflow_instances
       WHERE workflow_name = $1 AND definition_version = $2
         AND NOT (current_state = ANY($3::text[]))`,
      [options.workflowName, options.definitionVersion, [...options.excludeStates]],
    );
    return (result.rows[0] as { count: number }).count;
  }

  async findInstanceUuids(options: {
    workflowName: string;
    definitionVersion: number;
    limit: number;
    afterUuid?: string;
    states?: readonly string[];
    excludeStates?: readonly string[];
  }): Promise<string[]> {
    const client = this.getClient();
    const result = await client.query(
      `SELECT uuid FROM workflow_instances
       WHERE workflow_name = $1 AND definition_version = $2
         AND ($3::uuid IS NULL OR uuid > $3::uuid)
         AND ($5::text[] IS NULL OR current_state = ANY($5::text[]))
         AND ($6::text[] IS NULL OR NOT (current_state = ANY($6::text[])))
       ORDER BY uuid
       LIMIT $4`,
      [
        options.workflowName,
        options.definitionVersion,
        options.afterUuid ?? null,
        options.limit,
        options.states ? [...options.states] : null,
        options.excludeStates ? [...options.excludeStates] : null,
      ],
    );
    return result.rows.map((row: { uuid: string }) => row.uuid);
  }

  private mapRow(row: Record<string, unknown>): WorkflowInstance {
    return {
      uuid: row.uuid as string,
      workflowName: row.workflow_name as string,
      currentState: row.current_state as string,
      version: row.version as number,
      definitionVersion: (row.definition_version as number | null | undefined) ?? null,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      timeoutRetry: mapTimeoutRetry(row),
      lastTransitionAt: new Date(row.last_transition_at as string),
      context: row.context_json as Record<string, unknown>,
      metadata: row.metadata_json as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
