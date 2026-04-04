import type { Kysely, Transaction } from "kysely";
import type { WorkflowPersistenceProvider } from "@duraflows/core";
import type { WorkflowDatabase } from "./kysely-database.js";
import { KyselyWorkflowInstanceStore } from "./kysely-instance-store.js";
import { KyselyWorkflowHistoryStore } from "./kysely-history-store.js";
import { KyselyTransactionRunner } from "./kysely-transaction-runner.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

export { KyselyTransactionContext } from "./kysely-transaction-context.js";
export { KyselyTransactionRunner } from "./kysely-transaction-runner.js";
export { KyselyWorkflowInstanceStore } from "./kysely-instance-store.js";
export { KyselyWorkflowHistoryStore } from "./kysely-history-store.js";
export type { WorkflowDatabase, WorkflowInstancesTable, WorkflowHistoryTable } from "./kysely-database.js";

export function kyselyWorkflowProviders(db: Kysely<WorkflowDatabase>): WorkflowPersistenceProvider {
  const transactionRunner = new KyselyTransactionRunner(db);
  const instanceStore = new KyselyWorkflowInstanceStore(db);
  const historyStore = new KyselyWorkflowHistoryStore(db);
  return { instanceStore, historyStore, transactionRunner };
}

export function kyselyWorkflowProvidersFromTransaction(
  trx: Transaction<WorkflowDatabase>,
): WorkflowPersistenceProvider {
  const transactionRunner: WorkflowPersistenceProvider["transactionRunner"] = {
    async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
      const existing = KyselyTransactionContext.getTransaction();
      if (existing) {
        return callback();
      }
      return KyselyTransactionContext.run(trx, callback);
    },
  };
  const instanceStore = new KyselyWorkflowInstanceStore(trx as unknown as Kysely<WorkflowDatabase>);
  const historyStore = new KyselyWorkflowHistoryStore(trx as unknown as Kysely<WorkflowDatabase>);
  return { instanceStore, historyStore, transactionRunner };
}
