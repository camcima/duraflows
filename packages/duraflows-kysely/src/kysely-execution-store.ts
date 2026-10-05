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
  async countInstancesUsingDefinition(options: {
    workflowName: string;
    definitionVersion: number;
    excludeStates: readonly string[];
  }): Promise<number> {
    const executor = this.executor();
    let stamped = executor
      .selectFrom("workflow_instances")
      .select("uuid")
      .where("workflow_name", "=", options.workflowName)
      .where("definition_version", "=", options.definitionVersion);
    if (options.excludeStates.length > 0)
      stamped = stamped.where("current_state", "not in", [...options.excludeStates]);
    const queued = executor
      .selectFrom("workflow_executions")
      .select("workflow_instance_uuid as uuid")
      .where("status", "in", ["pending", "running", "parked"])
      .where((eb) => eb(eb.ref("execution_json", "->>").key("workflowName"), "=", options.workflowName))
      .where((eb) =>
        eb(
          eb.fn.coalesce(
            eb.cast<string>(eb.ref("execution_json", "->>").key("definition").key("version"), "text"),
            eb.val("1"),
          ),
          "=",
          String(options.definitionVersion),
        ),
      );
    const row = await executor
      .selectFrom(stamped.union(queued).as("definition_usage"))
      .select((eb) => eb.fn.countAll<number | string | bigint>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(row.count);
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
