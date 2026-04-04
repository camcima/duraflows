import { AsyncLocalStorage } from "node:async_hooks";
import type { Transaction } from "kysely";
import type { WorkflowDatabase } from "./kysely-database.js";

const storage = new AsyncLocalStorage<Transaction<WorkflowDatabase>>();

export const KyselyTransactionContext = {
  getTransaction(): Transaction<WorkflowDatabase> | undefined {
    return storage.getStore();
  },

  run<T>(trx: Transaction<WorkflowDatabase>, callback: () => T): T {
    return storage.run(trx, callback);
  },
};
