import { AsyncLocalStorage } from "node:async_hooks";
import type { Transaction } from "kysely";
import type { WorkflowDatabase } from "./kysely-database.js";

const storage = new AsyncLocalStorage<Transaction<WorkflowDatabase>>();

export const KyselyTransactionContext = {
  getTransaction(): Transaction<WorkflowDatabase> | undefined {
    return storage.getStore();
  },

  /**
   * Executes callback with `trx` as the active transaction context.
   *
   * Generic so callers can pass `Transaction<MyDb & WorkflowDatabase>`
   * (Kysely is invariant in DB, so a non-generic signature would reject
   * intersection-typed transactions). The stored value is narrowed to
   * `Transaction<WorkflowDatabase>` which is safe — stores only access
   * workflow tables.
   */
  run<T, DB extends WorkflowDatabase = WorkflowDatabase>(trx: Transaction<DB>, callback: () => T): T {
    return storage.run(trx as unknown as Transaction<WorkflowDatabase>, callback);
  },
};
