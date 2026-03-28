import type { Pool } from "pg";
import type { WorkflowTransactionRunner } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

export class PgTransactionRunner implements WorkflowTransactionRunner {
  constructor(private readonly pool: Pool) {}

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    // If already within a transaction, reuse the existing client
    const existingClient = PgTransactionContext.getClient();
    if (existingClient) {
      return callback();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await PgTransactionContext.run(client, callback);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
