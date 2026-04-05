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

/**
 * Creates long-lived persistence providers from a Kysely instance.
 *
 * Generic so callers can pass `Kysely<MyDb & WorkflowDatabase>`.
 * Internally narrows to `Kysely<WorkflowDatabase>` (safe — stores
 * only access workflow tables; the `unknown` cast is needed because
 * Kysely is invariant in its DB type parameter).
 */
export function kyselyWorkflowProviders<DB extends WorkflowDatabase>(db: Kysely<DB>): WorkflowPersistenceProvider {
  const narrowed = db as unknown as Kysely<WorkflowDatabase>;
  const transactionRunner = new KyselyTransactionRunner(narrowed);
  const instanceStore = new KyselyWorkflowInstanceStore(narrowed);
  const historyStore = new KyselyWorkflowHistoryStore(narrowed);
  return { instanceStore, historyStore, transactionRunner };
}

/**
 * Creates providers pre-bound to an existing Kysely transaction.
 *
 * Generic so callers can pass `Transaction<MyDb & WorkflowDatabase>`.
 */
export function kyselyWorkflowProvidersFromTransaction<DB extends WorkflowDatabase>(
  trx: Transaction<DB>,
): WorkflowPersistenceProvider {
  const narrowed = trx as unknown as Kysely<WorkflowDatabase>;
  const transactionRunner: WorkflowPersistenceProvider["transactionRunner"] = {
    async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
      const existing = KyselyTransactionContext.getTransaction();
      if (existing) {
        return callback();
      }
      return KyselyTransactionContext.run(trx, callback);
    },
  };
  const instanceStore = new KyselyWorkflowInstanceStore(narrowed);
  const historyStore = new KyselyWorkflowHistoryStore(narrowed);
  return { instanceStore, historyStore, transactionRunner };
}
