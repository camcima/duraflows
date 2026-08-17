import type { Pool, PoolClient } from "pg";
import type { WorkflowDefinitionStore, StoredWorkflowDefinition, WorkflowDefinition } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

export class PgWorkflowDefinitionStore implements WorkflowDefinitionStore {
  constructor(private readonly pool: Pool) {}

  private getClient(): PoolClient | Pool {
    return PgTransactionContext.getClient(this.pool) ?? this.pool;
  }

  async ensure(record: {
    workflowName: string;
    version: number;
    contentHash: string;
    definitionJson: WorkflowDefinition;
  }): Promise<StoredWorkflowDefinition> {
    const client = this.getClient();
    await client.query(
      `INSERT INTO workflow_definitions (workflow_name, version, content_hash, definition_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workflow_name, version) DO NOTHING`,
      [record.workflowName, record.version, record.contentHash, JSON.stringify(record.definitionJson)],
    );
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
    const client = this.getClient();
    const result = await client.query("SELECT * FROM workflow_definitions WHERE workflow_name = $1 AND version = $2", [
      workflowName,
      version,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      workflowName: row.workflow_name as string,
      version: row.version as number,
      contentHash: row.content_hash as string,
      definitionJson: row.definition_json as WorkflowDefinition,
      registeredAt: new Date(row.registered_at as string),
    };
  }
}
