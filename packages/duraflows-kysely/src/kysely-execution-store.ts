import type { Kysely } from "kysely";
import type { DurableWorkflowExecution, WorkflowExecutionStore } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import type { WorkflowDatabase, WorkflowDatabaseWithExecutions } from "./kysely-database.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

export class KyselyWorkflowExecutionStore<
  DB extends WorkflowDatabase = WorkflowDatabase,
> implements WorkflowExecutionStore {
  constructor(private readonly db: Kysely<DB>) {}
  private executor(write = false): Kysely<WorkflowDatabaseWithExecutions> {
    const transaction = KyselyTransactionContext.getTransaction(this.db as unknown as Kysely<WorkflowDatabase>);
    if (write && !transaction) throw new WorkflowError("WorkflowExecutionStore writes require an active transaction");
    return (transaction ?? this.db) as unknown as Kysely<WorkflowDatabaseWithExecutions>;
  }
  async create(e: DurableWorkflowExecution): Promise<void> {
    await this.executor(true)
      .insertInto("workflow_executions")
      .values({
        uuid: e.uuid,
        workflow_instance_uuid: e.workflowInstanceUuid,
        idempotency_key: e.idempotencyKey,
        status: e.status,
        available_at: new Date(e.availableAt),
        lease_until: e.leaseUntil === null ? null : new Date(e.leaseUntil),
        revision: e.revision,
        execution_json: JSON.stringify(e),
      })
      .execute();
  }
  async update(e: DurableWorkflowExecution): Promise<void> {
    const result = await this.executor(true)
      .updateTable("workflow_executions")
      .set({
        status: e.status,
        available_at: new Date(e.availableAt),
        lease_until: e.leaseUntil === null ? null : new Date(e.leaseUntil),
        revision: e.revision,
        execution_json: JSON.stringify(e),
      })
      .where("uuid", "=", e.uuid)
      .where("revision", "=", e.revision - 1)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new WorkflowError("Durable execution revision conflict");
  }
  async findByUuid(uuid: string): Promise<DurableWorkflowExecution | null> {
    const row = await this.executor()
      .selectFrom("workflow_executions")
      .select("execution_json")
      .where("uuid", "=", uuid)
      .executeTakeFirst();
    return row?.execution_json ?? null;
  }
  async findByKey(uuid: string, key: string): Promise<DurableWorkflowExecution | null> {
    const row = await this.executor()
      .selectFrom("workflow_executions")
      .select("execution_json")
      .where("workflow_instance_uuid", "=", uuid)
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
    return row?.execution_json ?? null;
  }
  async findActive(uuid: string): Promise<DurableWorkflowExecution | null> {
    const row = await this.executor()
      .selectFrom("workflow_executions")
      .select("execution_json")
      .where("workflow_instance_uuid", "=", uuid)
      .where("status", "in", ["pending", "running", "parked"])
      .executeTakeFirst();
    return row?.execution_json ?? null;
  }
  async findDue(limit: number, now: Date): Promise<DurableWorkflowExecution[]> {
    const rows = await this.executor()
      .selectFrom("workflow_executions")
      .select("execution_json")
      .where("status", "in", ["pending", "running"])
      .where("available_at", "<=", now)
      .where((eb) => eb.or([eb("lease_until", "is", null), eb("lease_until", "<=", now)]))
      .orderBy("available_at")
      .orderBy("uuid")
      .limit(limit)
      .execute();
    return rows.map((row) => row.execution_json);
  }
}
