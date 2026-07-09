import type { Pool } from "pg";
import type { WorkflowTransactionRunner } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

export class PgTransactionRunner implements WorkflowTransactionRunner {
  constructor(private readonly pool: Pool) {}

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    // If already within a transaction, reuse the existing client
    const existingClient = PgTransactionContext.getClient(this.pool);
    if (existingClient) {
      return callback();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await PgTransactionContext.run(this.pool, client, callback);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Never mask the causative error with a rollback failure.
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.warn(`[duraflows] ROLLBACK failed after transaction error: ${message}`);
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
