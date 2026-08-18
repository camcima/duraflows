import type { Kysely, Transaction } from "kysely";
import type { WorkflowPersistenceProvider } from "@duraflows/core";
import type { WorkflowDatabase } from "./kysely-database.js";
import { KyselyWorkflowInstanceStore } from "./kysely-instance-store.js";
import { KyselyWorkflowHistoryStore } from "./kysely-history-store.js";
import { KyselyWorkflowDefinitionStore } from "./kysely-definition-store.js";
import { KyselyTransactionRunner, type KyselyTransactionRunnerOptions } from "./kysely-transaction-runner.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

export { KyselyTransactionContext } from "./kysely-transaction-context.js";
export { KyselyTransactionRunner } from "./kysely-transaction-runner.js";
export type { KyselyTransactionRunnerOptions } from "./kysely-transaction-runner.js";
export { KyselyWorkflowInstanceStore } from "./kysely-instance-store.js";
export { KyselyWorkflowHistoryStore } from "./kysely-history-store.js";
export { KyselyWorkflowDefinitionStore } from "./kysely-definition-store.js";
export type {
  WorkflowDatabase,
  WorkflowInstancesTable,
  WorkflowHistoryTable,
  WorkflowDefinitionsTable,
} from "./kysely-database.js";

/**
 * Options accepted by {@link kyselyWorkflowProviders}. Every field is optional
 * and omitting the argument entirely reproduces the pre-existing behaviour.
 */
export type KyselyWorkflowProvidersOptions = KyselyTransactionRunnerOptions;

/**
 * Creates long-lived persistence providers from a Kysely instance.
 *
 * Generic so callers can pass `Kysely<MyDb & WorkflowDatabase>`.
 * Internally narrows to `Kysely<WorkflowDatabase>` (safe — stores
 * only access workflow tables; the `unknown` cast is needed because
 * Kysely is invariant in its DB type parameter).
 */
export function kyselyWorkflowProviders<DB extends WorkflowDatabase>(
  db: Kysely<DB>,
  options: KyselyWorkflowProvidersOptions = {},
): WorkflowPersistenceProvider {
  const narrowed = db as unknown as Kysely<WorkflowDatabase>;
  const transactionRunner = new KyselyTransactionRunner(narrowed, options);
  const instanceStore = new KyselyWorkflowInstanceStore(narrowed);
  const historyStore = new KyselyWorkflowHistoryStore(narrowed);
  const definitionStore = new KyselyWorkflowDefinitionStore(narrowed);
  return { instanceStore, historyStore, transactionRunner, definitionStore };
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
      // Nested calls reuse the bound transaction; an unrelated ambient
      // transaction from another provider must never supersede it.
      if (KyselyTransactionContext.getTransaction(narrowed)) {
        return callback();
      }
      return KyselyTransactionContext.run(narrowed, trx, callback);
    },
  };
  const instanceStore = new KyselyWorkflowInstanceStore(narrowed);
  const historyStore = new KyselyWorkflowHistoryStore(narrowed);
  const definitionStore = new KyselyWorkflowDefinitionStore(narrowed);
  return { instanceStore, historyStore, transactionRunner, definitionStore };
}
