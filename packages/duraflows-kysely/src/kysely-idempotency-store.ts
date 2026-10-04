import type { Kysely } from "kysely";
import type {
  WorkflowIdempotencyStore,
  WorkflowIdempotencyRecord,
  WorkflowIdempotencyReservation,
  WorkflowExecutionResult,
} from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import type { WorkflowDatabase, WorkflowDatabaseWithIdempotency } from "./kysely-database.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

export class KyselyWorkflowIdempotencyStore<
  DB extends WorkflowDatabase = WorkflowDatabase,
> implements WorkflowIdempotencyStore {
  constructor(private readonly db: Kysely<DB>) {}

  private getExecutor(): Kysely<WorkflowDatabaseWithIdempotency> {
    const transaction = KyselyTransactionContext.getTransaction(this.db as unknown as Kysely<WorkflowDatabase>);
    if (!transaction) throw new WorkflowError("WorkflowIdempotencyStore requires an active transaction");
    // Same database object/context as the other stores; this optional table
    // must not become a required member of consumers' existing DB types.
    return transaction as unknown as Kysely<WorkflowDatabaseWithIdempotency>;
  }

  async find(workflowInstanceUuid: string, key: string): Promise<WorkflowIdempotencyRecord | null> {
    const row = await this.getExecutor()
      .selectFrom("workflow_event_idempotency")
      .selectAll()
      .where("workflow_instance_uuid", "=", workflowInstanceUuid)
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
    if (!row) return null;
    return {
      workflowInstanceUuid: row.workflow_instance_uuid,
      key: row.idempotency_key,
      eventName: row.event_name,
      fingerprint: row.fingerprint ?? undefined,
      result: row.result_json,
      createdAt: row.created_at,
    };
  }

  async reserve(input: WorkflowIdempotencyReservation): Promise<void> {
    await this.getExecutor()
      .insertInto("workflow_event_idempotency")
      .values({
        workflow_instance_uuid: input.workflowInstanceUuid,
        idempotency_key: input.key,
        event_name: input.eventName,
        fingerprint: input.fingerprint ?? null,
      })
      .execute();
  }

  async complete(workflowInstanceUuid: string, key: string, result: WorkflowExecutionResult): Promise<void> {
    const updated = await this.getExecutor()
      .updateTable("workflow_event_idempotency")
      .set({ result_json: JSON.stringify(result) })
      .where("workflow_instance_uuid", "=", workflowInstanceUuid)
      .where("idempotency_key", "=", key)
      .where("result_json", "is", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n)
      throw new WorkflowError("Idempotency reservation is missing or already completed");
  }
}
