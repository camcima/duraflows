import type { Kysely } from "kysely";
import type { WorkflowHistoryStore, WorkflowHistoryRecord } from "@duraflows/core";
import type { WorkflowDatabase } from "./kysely-database.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

export class KyselyWorkflowHistoryStore implements WorkflowHistoryStore {
  constructor(private readonly db: Kysely<WorkflowDatabase>) {}

  private getExecutor() {
    return KyselyTransactionContext.getTransaction() ?? this.db;
  }

  async append(entry: WorkflowHistoryRecord): Promise<string> {
    const executor = this.getExecutor();
    const row = await executor
      .insertInto("workflow_history")
      .values({
        workflow_instance_uuid: entry.workflowInstanceUuid,
        from_state: entry.fromState,
        event_name: entry.eventName,
        to_state: entry.toState,
        outcome: entry.outcome,
        error_message: entry.errorMessage ?? null,
        command_results_json: JSON.stringify(entry.commandResultsJson),
        trigger_metadata_json: JSON.stringify(entry.triggerMetadata ?? {}),
      })
      .returning("uuid")
      .executeTakeFirstOrThrow();

    return row.uuid;
  }

  async findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    const executor = this.getExecutor();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const rows = await executor
      .selectFrom("workflow_history")
      .selectAll()
      .where("workflow_instance_uuid", "=", workflowInstanceUuid)
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    return rows.map((row) => ({
      workflowInstanceUuid: row.workflow_instance_uuid,
      fromState: row.from_state,
      eventName: row.event_name,
      toState: row.to_state,
      outcome: row.outcome as "success" | "failure",
      errorMessage: row.error_message ?? undefined,
      commandResultsJson: row.command_results_json as unknown as WorkflowHistoryRecord["commandResultsJson"],
      triggerMetadata: row.trigger_metadata_json as Record<string, unknown> | undefined,
    }));
  }
}
