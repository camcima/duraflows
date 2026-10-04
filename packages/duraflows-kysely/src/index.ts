import type { Kysely, Transaction } from "kysely";
import type { WorkflowPersistenceProvider, WorkflowTransactionRunner } from "@duraflows/core";
import { runAfterCommitCallbacks } from "@duraflows/core";
import type { WorkflowDatabase } from "./kysely-database.js";
import { KyselyWorkflowInstanceStore } from "./kysely-instance-store.js";
import { KyselyWorkflowHistoryStore } from "./kysely-history-store.js";
import { KyselyWorkflowDefinitionStore } from "./kysely-definition-store.js";
import { KyselyWorkflowIdempotencyStore } from "./kysely-idempotency-store.js";
import { KyselyTransactionRunner, type KyselyTransactionRunnerOptions } from "./kysely-transaction-runner.js";
import { kyselyTransactionScopes, runInKyselySavepoint } from "./kysely-transaction-context.js";

export { KyselyTransactionContext } from "./kysely-transaction-context.js";
export { KyselyTransactionRunner } from "./kysely-transaction-runner.js";
export type { KyselyTransactionRunnerOptions } from "./kysely-transaction-runner.js";
export { KyselyWorkflowInstanceStore } from "./kysely-instance-store.js";
export { KyselyWorkflowHistoryStore } from "./kysely-history-store.js";
export { KyselyWorkflowDefinitionStore } from "./kysely-definition-store.js";
export { KyselyWorkflowIdempotencyStore } from "./kysely-idempotency-store.js";
export type {
  WorkflowDatabase,
  WorkflowInstancesTable,
  WorkflowHistoryTable,
  WorkflowDefinitionsTable,
  WorkflowEventIdempotencyTable,
  WorkflowDatabaseWithIdempotency,
} from "./kysely-database.js";

/**
 * Options accepted by {@link kyselyWorkflowProviders}. Every field is optional
 * and omitting the argument entirely reproduces the pre-existing behaviour.
 */
export interface KyselyWorkflowProvidersOptions extends KyselyTransactionRunnerOptions {
  /** Opt-in; apply the event-idempotency migration before keyed calls. */
  idempotency?: boolean;
}

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
  return {
    instanceStore,
    historyStore,
    transactionRunner,
    definitionStore,
    ...(options.idempotency ? { idempotencyStore: new KyselyWorkflowIdempotencyStore(narrowed) } : {}),
  };
}

/**
 * Creates providers pre-bound to an existing Kysely transaction.
 *
 * Generic so callers can pass `Transaction<MyDb & WorkflowDatabase>`.
 */
export function kyselyWorkflowProvidersFromTransaction<DB extends WorkflowDatabase>(
  trx: Transaction<DB>,
  options: Pick<KyselyWorkflowProvidersOptions, "idempotency"> = {},
): WorkflowPersistenceProvider {
  const narrowed = trx as unknown as Kysely<WorkflowDatabase>;
  const boundTrx = trx as unknown as Transaction<WorkflowDatabase>;
  const transactionRunner: WorkflowTransactionRunner = {
    async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
      // Scoped to the bound trx; an unrelated ambient transaction from another
      // provider must never supersede it.
      const scope = kyselyTransactionScopes.current(narrowed);
      if (scope) {
        return runInKyselySavepoint(narrowed, scope, callback);
      }
      // The caller owns `trx`, so even this outermost call is nested in their
      // transaction: run it in a savepoint so a failure leaves no partial
      // writes behind, and deliver its observers once it resolves. `trx` is
      // still open then, so the observers run inside the root scope: a
      // duraflows call they make joins `trx` as a savepoint, and the
      // callbacks it queues drain in the same pass.
      const root = kyselyTransactionScopes.createRoot(boundTrx);
      const result = await kyselyTransactionScopes.run(narrowed, root, () =>
        runInKyselySavepoint(narrowed, root, callback),
      );
      await kyselyTransactionScopes.run(narrowed, root, () => runAfterCommitCallbacks(root.callbacks));
      return result;
    },
    afterCommit(callback) {
      kyselyTransactionScopes.afterCommit(narrowed, callback);
    },
  };
  const instanceStore = new KyselyWorkflowInstanceStore(narrowed);
  const historyStore = new KyselyWorkflowHistoryStore(narrowed);
  const definitionStore = new KyselyWorkflowDefinitionStore(narrowed);
  return {
    instanceStore,
    historyStore,
    transactionRunner,
    definitionStore,
    ...(options.idempotency ? { idempotencyStore: new KyselyWorkflowIdempotencyStore(narrowed) } : {}),
  };
}
