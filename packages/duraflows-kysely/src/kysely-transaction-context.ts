import { AsyncLocalStorage } from "node:async_hooks";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowDatabase } from "./kysely-database.js";

// One context per Kysely instance (or per pre-bound Transaction): a
// transaction on db A is invisible to stores and runners bound to db B.
const storages = new WeakMap<Kysely<WorkflowDatabase>, AsyncLocalStorage<Transaction<WorkflowDatabase>>>();

function storageFor(owner: Kysely<WorkflowDatabase>): AsyncLocalStorage<Transaction<WorkflowDatabase>> {
  let storage = storages.get(owner);
  if (!storage) {
    storage = new AsyncLocalStorage<Transaction<WorkflowDatabase>>();
    storages.set(owner, storage);
  }
  return storage;
}

export const KyselyTransactionContext = {
  getTransaction(owner: Kysely<WorkflowDatabase>): Transaction<WorkflowDatabase> | undefined {
    return storages.get(owner)?.getStore();
  },

  /**
   * Executes callback with `trx` as the active transaction for `owner`.
   *
   * Generic so callers can pass `Transaction<MyDb & WorkflowDatabase>`
   * (Kysely is invariant in DB, so a non-generic signature would reject
   * intersection-typed transactions). The stored value is narrowed to
   * `Transaction<WorkflowDatabase>` which is safe — stores only access
   * workflow tables.
   */
  run<T, DB extends WorkflowDatabase = WorkflowDatabase>(
    owner: Kysely<WorkflowDatabase>,
    trx: Transaction<DB>,
    callback: () => T,
  ): T {
    return storageFor(owner).run(trx as unknown as Transaction<WorkflowDatabase>, callback);
  },
};
