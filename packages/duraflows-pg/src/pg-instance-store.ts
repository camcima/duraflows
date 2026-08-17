import type { Pool, PoolClient } from "pg";
import type { WorkflowInstanceStore, WorkflowInstance } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

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
        created_at, updated_at, definition_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
        definition_version = $8
      WHERE uuid = $1 AND version = $9`,
      [
        instance.uuid,
        instance.currentState,
        instance.version,
        instance.expiresAt,
        instance.lastTransitionAt,
        JSON.stringify(instance.context),
        instance.updatedAt,
        instance.definitionVersion,
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
       ORDER BY expires_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit, now],
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): WorkflowInstance {
    return {
      uuid: row.uuid as string,
      workflowName: row.workflow_name as string,
      currentState: row.current_state as string,
      version: row.version as number,
      definitionVersion: (row.definition_version as number | null | undefined) ?? null,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      lastTransitionAt: new Date(row.last_transition_at as string),
      context: row.context_json as Record<string, unknown>,
      metadata: row.metadata_json as Record<string, unknown>,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
