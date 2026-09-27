import type { Kysely, Selectable } from "kysely";
import type { WorkflowInstanceStore, WorkflowInstance, WorkflowTimeoutRetry } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import type { WorkflowDatabase, WorkflowInstancesTable } from "./kysely-database.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

/** The four timeout-retry column values for `retry` (`null` ⇒ never failed). */
function timeoutRetryColumns(retry: WorkflowTimeoutRetry | null) {
  return {
    timeout_attempts: retry?.attempts ?? 0,
    timeout_retry_at: retry?.retryAt ?? null,
    timeout_last_error: retry?.lastError ?? null,
    timeout_parked_at: retry?.parkedAt ?? null,
  };
}

export class KyselyWorkflowInstanceStore implements WorkflowInstanceStore {
  constructor(private readonly db: Kysely<WorkflowDatabase>) {}

  private getExecutor() {
    return KyselyTransactionContext.getTransaction(this.db) ?? this.db;
  }

  async create(instance: WorkflowInstance): Promise<void> {
    const executor = this.getExecutor();
    await executor
      .insertInto("workflow_instances")
      .values({
        uuid: instance.uuid,
        workflow_name: instance.workflowName,
        current_state: instance.currentState,
        version: instance.version,
        definition_version: instance.definitionVersion,
        expires_at: instance.expiresAt,
        last_transition_at: instance.lastTransitionAt,
        context_json: JSON.stringify(instance.context),
        metadata_json: JSON.stringify(instance.metadata),
        created_at: instance.createdAt,
        updated_at: instance.updatedAt,
        ...timeoutRetryColumns(instance.timeoutRetry),
      })
      .execute();
  }

  async findByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const executor = this.getExecutor();
    const row = await executor.selectFrom("workflow_instances").selectAll().where("uuid", "=", uuid).executeTakeFirst();

    if (!row) return null;
    return this.mapRow(row);
  }

  async lockByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const trx = KyselyTransactionContext.getTransaction(this.db);
    if (!trx) {
      throw new WorkflowError("lockByUuid requires an active transaction");
    }
    const row = await trx
      .selectFrom("workflow_instances")
      .selectAll()
      .where("uuid", "=", uuid)
      .forUpdate()
      .executeTakeFirst();

    if (!row) return null;
    return this.mapRow(row);
  }

  async update(instance: WorkflowInstance): Promise<void> {
    const executor = this.getExecutor();
    const expectedVersion = instance.version - 1;
    const result = await executor
      .updateTable("workflow_instances")
      .set({
        current_state: instance.currentState,
        version: instance.version,
        definition_version: instance.definitionVersion,
        expires_at: instance.expiresAt,
        last_transition_at: instance.lastTransitionAt,
        context_json: JSON.stringify(instance.context),
        updated_at: instance.updatedAt,
        ...timeoutRetryColumns(instance.timeoutRetry),
      })
      .where("uuid", "=", instance.uuid)
      .where("version", "=", expectedVersion)
      .execute();

    const numUpdatedRows = result[0]?.numUpdatedRows ?? BigInt(0);
    if (numUpdatedRows === BigInt(0)) {
      throw new WorkflowError(
        `Optimistic locking failure: workflow instance "${instance.uuid}" was modified concurrently (expected version ${expectedVersion})`,
      );
    }
  }

  async findExpired(limit: number, now: Date): Promise<WorkflowInstance[]> {
    const trx = KyselyTransactionContext.getTransaction(this.db);
    if (!trx) {
      throw new WorkflowError("findExpired requires an active transaction");
    }
    const rows = await trx
      .selectFrom("workflow_instances")
      .selectAll()
      .where("expires_at", "is not", null)
      .where("expires_at", "<", now)
      .where("timeout_parked_at", "is", null)
      .where((eb) => eb.or([eb("timeout_retry_at", "is", null), eb("timeout_retry_at", "<", now)]))
      .orderBy((eb) => eb.fn.coalesce("timeout_retry_at", "expires_at"))
      .forUpdate()
      .skipLocked()
      .limit(limit)
      .execute();

    return rows.map((row) => this.mapRow(row));
  }

  async findParkedTimeouts(options: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]> {
    let query = this.getExecutor()
      .selectFrom("workflow_instances")
      .selectAll()
      .where("timeout_parked_at", "is not", null);
    if (options.workflowName !== undefined) {
      query = query.where("workflow_name", "=", options.workflowName);
    }
    const rows = await query.orderBy("timeout_parked_at").orderBy("uuid").limit(options.limit).execute();
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Selectable<WorkflowInstancesTable>): WorkflowInstance {
    return {
      uuid: row.uuid,
      workflowName: row.workflow_name,
      currentState: row.current_state,
      version: row.version,
      definitionVersion: row.definition_version ?? null,
      expiresAt: row.expires_at,
      timeoutRetry:
        row.timeout_attempts > 0
          ? {
              attempts: row.timeout_attempts,
              lastError: row.timeout_last_error ?? "",
              retryAt: row.timeout_retry_at,
              parkedAt: row.timeout_parked_at,
            }
          : null,
      lastTransitionAt: row.last_transition_at,
      context: row.context_json,
      metadata: row.metadata_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
