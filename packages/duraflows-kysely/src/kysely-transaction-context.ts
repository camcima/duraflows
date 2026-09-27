import { randomUUID } from "node:crypto";
import type { CompiledQuery, Kysely, Transaction } from "kysely";
import { ScopedTransactionContext, runAfterCommitCallbacks, type TransactionScope } from "@duraflows/core";
import type { WorkflowDatabase } from "./kysely-database.js";

type WorkflowTransaction = Transaction<WorkflowDatabase>;

// One context per Kysely instance, so a transaction on db A is invisible to
// stores and runners bound to db B.
/** @internal Shared with the runners; not part of the public API. */
export const kyselyTransactionScopes = new ScopedTransactionContext<Kysely<WorkflowDatabase>, WorkflowTransaction>();

/**
 * Runs one fixed SQL statement (a savepoint command) on `trx`.
 *
 * `Transaction` has no savepoint API in kysely 0.29 (only `ControlledTransaction`
 * does), and this package imports kysely for types only, since kysely is
 * ESM-only and a runtime import would break the CommonJS build. So the
 * statement is handed to `executeQuery` as a compiled query built by hand,
 * shaped exactly like `CompiledQuery.raw(sql)`. `sql` is always an internally
 * generated `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` statement, never user input.
 */
function executeRawStatement(trx: WorkflowTransaction, sql: string): Promise<unknown> {
  const query: CompiledQuery = {
    sql,
    parameters: [],
    query: { kind: "RawNode", sqlFragments: [sql], parameters: [] } as unknown as CompiledQuery["query"],
    queryId: { queryId: `duraflows_${randomUUID()}` },
  };
  return trx.executeQuery(query);
}

/**
 * @internal Runs `callback` in a savepoint nested in `scope`, issuing the
 * savepoint statements on that scope's own transaction. Every kysely entry
 * point that nests (the runners and `transaction()`) goes through here.
 */
export function runInKyselySavepoint<T>(
  owner: Kysely<WorkflowDatabase>,
  scope: TransactionScope<WorkflowTransaction>,
  callback: () => Promise<T>,
): Promise<T> {
  return kyselyTransactionScopes.runInSavepoint(owner, scope, callback, (sql) =>
    executeRawStatement(scope.connection, sql),
  );
}

/**
 * @internal Runs `callback` as the root of a new kysely transaction on `db`
 * (after `setup`, e.g. transaction-local timeouts), and only once kysely has
 * committed runs the after-commit callbacks queued inside. On error kysely
 * rolls back and the callbacks are dropped.
 */
export async function runOwnedKyselyTransaction<T>(
  db: Kysely<WorkflowDatabase>,
  setup: (trx: WorkflowTransaction) => Promise<void>,
  callback: (trx: WorkflowTransaction) => Promise<T>,
): Promise<T> {
  let root: TransactionScope<WorkflowTransaction> | undefined;
  const result = await db.transaction().execute(async (trx) => {
    await setup(trx);
    const scope = kyselyTransactionScopes.createRoot(trx);
    root = scope;
    return kyselyTransactionScopes.run(db, scope, () => callback(trx));
  });
  if (root) {
    await runAfterCommitCallbacks(root.callbacks);
  }
  return result;
}

export const KyselyTransactionContext = {
  getTransaction(owner: Kysely<WorkflowDatabase>): WorkflowTransaction | undefined {
    return kyselyTransactionScopes.current(owner)?.connection;
  },

  /**
   * Executes callback with `trx` as the active transaction for `owner`. You
   * own the transaction. Workflow calls inside run in savepoints, and their
   * observers fire when `callback`'s promise resolves (before your COMMIT);
   * nothing fires if it rejects. Use {@link KyselyTransactionContext.transaction}
   * for delivery strictly after COMMIT.
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
    return kyselyTransactionScopes.runSeeded(owner, trx as unknown as WorkflowTransaction, callback);
  },

  /**
   * Runs `callback` in a new transaction on `db` (`db.transaction().execute`),
   * with that transaction active for workflow calls. Observers of workflow
   * calls made inside fire after the transaction commits, and never if it
   * rolls back.
   *
   * Called while a transaction for `db` is already active (an outer
   * `transaction()`, a workflow call, or a seeded `run()`), it joins that
   * transaction instead: `callback` receives the existing transaction and runs
   * in a savepoint, which is released on success (its observers then wait for
   * the enclosing transaction) and rolled back on failure (its observers are
   * dropped).
   */
  transaction<T, DB extends WorkflowDatabase = WorkflowDatabase>(
    db: Kysely<DB>,
    callback: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    const owner = db as unknown as Kysely<WorkflowDatabase>;
    const scope = kyselyTransactionScopes.current(owner);
    if (scope) {
      return runInKyselySavepoint(owner, scope, () => callback(scope.connection as unknown as Transaction<DB>));
    }
    return runOwnedKyselyTransaction(
      owner,
      async () => {},
      (trx) => callback(trx as unknown as Transaction<DB>),
    );
  },
};
