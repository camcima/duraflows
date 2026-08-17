import type { Kysely, Selectable } from "kysely";
import type { WorkflowDefinitionStore, StoredWorkflowDefinition, WorkflowDefinition } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import type { WorkflowDatabase, WorkflowDefinitionsTable } from "./kysely-database.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

export class KyselyWorkflowDefinitionStore implements WorkflowDefinitionStore {
  constructor(private readonly db: Kysely<WorkflowDatabase>) {}

  private getExecutor() {
    return KyselyTransactionContext.getTransaction(this.db) ?? this.db;
  }

  async ensure(record: {
    workflowName: string;
    version: number;
    contentHash: string;
    definitionJson: WorkflowDefinition;
  }): Promise<StoredWorkflowDefinition> {
    const executor = this.getExecutor();
    await executor
      .insertInto("workflow_definitions")
      .values({
        workflow_name: record.workflowName,
        version: record.version,
        content_hash: record.contentHash,
        definition_json: JSON.stringify(record.definitionJson),
      })
      .onConflict((oc) => oc.columns(["workflow_name", "version"]).doNothing())
      .execute();

    const stored = await this.findByNameAndVersion(record.workflowName, record.version);
    if (!stored) {
      // The row we just ensured must exist; its absence means the statement
      // did not do what the adapter assumes. Fail loudly.
      throw new WorkflowError(
        `Failed to ensure workflow definition "${record.workflowName}" version ${record.version}`,
      );
    }
    return stored;
  }

  async findByNameAndVersion(workflowName: string, version: number): Promise<StoredWorkflowDefinition | null> {
    const executor = this.getExecutor();
    const row = await executor
      .selectFrom("workflow_definitions")
      .selectAll()
      .where("workflow_name", "=", workflowName)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!row) return null;
    return this.mapRow(row);
  }

  private mapRow(row: Selectable<WorkflowDefinitionsTable>): StoredWorkflowDefinition {
    return {
      workflowName: row.workflow_name,
      version: row.version,
      contentHash: row.content_hash,
      definitionJson: row.definition_json as unknown as WorkflowDefinition,
      registeredAt: row.registered_at,
    };
  }
}
