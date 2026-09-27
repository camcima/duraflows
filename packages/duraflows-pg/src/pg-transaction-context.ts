import type { Pool, PoolClient } from "pg";
import { ScopedTransactionContext, runAfterCommitCallbacks } from "@duraflows/core";

// One context per Pool: a transaction on pool A is invisible to stores and
// runners bound to pool B, so multi-database deployments cannot cross wires.
/** @internal Shared with PgTransactionRunner; not part of the public API. */
export const pgTransactionScopes = new ScopedTransactionContext<Pool, PoolClient>();

/**
 * @internal Begins a transaction on a fresh client from `pool`, runs
 * `setupStatements` (e.g. `SET LOCAL` timeouts) and then `callback` with that
 * client as the active transaction, commits, releases the client, and only
 * then runs the after-commit callbacks queued inside. Rolls back (and drops
 * the callbacks) on any error.
 */
export async function runOwnedPgTransaction<T>(
  pool: Pool,
  setupStatements: readonly string[],
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const root = pgTransactionScopes.createRoot(client);
  let result: T;
  try {
    await client.query("BEGIN");
    // `SET LOCAL` is scoped to this transaction, so the settings are reverted
    // on COMMIT/ROLLBACK and never leak to other users of the shared pool.
    for (const statement of setupStatements) {
      await client.query(statement);
    }
    result = await pgTransactionScopes.run(pool, root, () => callback(client));
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Never mask the causative error with a rollback failure.
      const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      console.warn(`[duraflows] ROLLBACK failed after transaction error: ${message}`);
    }
    throw error;
  } finally {
    client.release();
  }
  await runAfterCommitCallbacks(root.callbacks);
  return result;
}

export const PgTransactionContext = {
  getClient(pool: Pool): PoolClient | undefined {
    return pgTransactionScopes.current(pool)?.connection;
  },

  /**
   * Makes `client` the active transaction for `pool` while `callback` runs.
   * You own BEGIN/COMMIT. Workflow calls inside run in savepoints, and their
   * observers fire when `callback`'s promise resolves (before your COMMIT);
   * nothing fires if it rejects. Use {@link PgTransactionContext.transaction}
   * for delivery strictly after COMMIT.
   */
  run<T>(pool: Pool, client: PoolClient, callback: () => T): T {
    return pgTransactionScopes.runSeeded(pool, client, callback);
  },

  /**
   * Runs `callback` in a new transaction on a client from `pool` (BEGIN …
   * COMMIT, ROLLBACK on error), with that client active for workflow calls.
   * Observers of workflow calls made inside fire after COMMIT, and never if
   * the transaction rolls back.
   */
  transaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    return runOwnedPgTransaction(pool, [], callback);
  },
};
