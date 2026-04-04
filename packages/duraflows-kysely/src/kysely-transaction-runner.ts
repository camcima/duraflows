import type { Kysely } from "kysely";
import type { WorkflowTransactionRunner } from "@duraflows/core";
import type { WorkflowDatabase } from "./kysely-database.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

export class KyselyTransactionRunner implements WorkflowTransactionRunner {
  constructor(private readonly db: Kysely<WorkflowDatabase>) {}

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    const existing = KyselyTransactionContext.getTransaction();
    if (existing) {
      return callback();
    }

    return this.db.transaction().execute(async (trx) => {
      return KyselyTransactionContext.run(trx, callback);
    });
  }
}
