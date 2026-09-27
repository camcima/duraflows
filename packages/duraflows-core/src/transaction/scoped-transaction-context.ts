import { AsyncLocalStorage } from "node:async_hooks";
import { WorkflowError } from "../errors/index.js";

/** A callback queued by `WorkflowTransactionRunner.afterCommit`. */
export type AfterCommitCallback = () => Promise<void>;

/**
 * One level of an active transaction: its root (BEGIN … COMMIT) or a savepoint
 * nested inside it. A nested scope hands its callbacks to its parent on
 * `RELEASE SAVEPOINT` and drops them on `ROLLBACK TO SAVEPOINT`; whoever
 * created the root runs them once the transaction's changes are durable.
 */
export interface TransactionScope<C> {
  /** The connection every statement of this transaction runs on. */
  readonly connection: C;
  /** Callbacks to run once this scope's changes are committed. */
  readonly callbacks: AfterCommitCallback[];
  /** Shared by every scope of one transaction; numbers its savepoints. */
  readonly root: { nextSavepointId: number };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Runs queued after-commit callbacks in order, each awaited. A callback that
 * throws is logged and skipped, so the rest still run and an operation whose
 * transaction already committed is never reported as failed.
 */
export async function runAfterCommitCallbacks(callbacks: readonly AfterCommitCallback[]): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      console.warn(`[duraflows] afterCommit callback failed: ${errorMessage(error)}`);
    }
  }
}

/**
 * AsyncLocalStorage of transaction scopes, keyed by owner. `K` is the object
 * a context belongs to (a pg `Pool`, a Kysely instance), so transactions on
 * different databases never see each other; `C` is the connection type.
 *
 * Adapters use it to implement `WorkflowTransactionRunner`: open a root with
 * `createRoot` + `run`, nest with `runInSavepoint`, queue with `afterCommit`,
 * and flush the root's callbacks with `runAfterCommitCallbacks` after COMMIT.
 */
export class ScopedTransactionContext<K extends object, C> {
  private readonly storages = new WeakMap<K, AsyncLocalStorage<TransactionScope<C>>>();

  /** The innermost scope active for `owner` on the current async context. */
  current(owner: K): TransactionScope<C> | undefined {
    return this.storages.get(owner)?.getStore();
  }

  /** A fresh root scope for a transaction on `connection`. */
  createRoot(connection: C): TransactionScope<C> {
    return { connection, callbacks: [], root: { nextSavepointId: 1 } };
  }

  /** Runs `callback` with `scope` as the active scope for `owner`. */
  run<T>(owner: K, scope: TransactionScope<C>, callback: () => T): T {
    return this.storageFor(owner).run(scope, callback);
  }

  /** Queues `callback` on the innermost active scope for `owner`. */
  afterCommit(owner: K, callback: AfterCommitCallback): void {
    const scope = this.current(owner);
    if (!scope) {
      throw new WorkflowError("afterCommit requires an active transaction");
    }
    scope.callbacks.push(callback);
  }

  /**
   * Runs `callback` in a savepoint nested in `parent`. On success the savepoint
   * is released and its callbacks move to `parent`; on failure it is rolled
   * back (and released), its callbacks are dropped, and the error is rethrown.
   * `execute` runs one SQL statement on `parent.connection`.
   */
  async runInSavepoint<T>(
    owner: K,
    parent: TransactionScope<C>,
    callback: () => Promise<T>,
    execute: (sql: string) => Promise<unknown>,
  ): Promise<T> {
    const savepoint = `duraflows_sp_${parent.root.nextSavepointId++}`;
    const child: TransactionScope<C> = { connection: parent.connection, callbacks: [], root: parent.root };

    await execute(`SAVEPOINT ${savepoint}`);
    let result: T;
    try {
      result = await this.run(owner, child, callback);
    } catch (error) {
      try {
        await execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await execute(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (rollbackError) {
        // Never mask the causative error with a rollback failure.
        console.warn(
          `[duraflows] ROLLBACK TO SAVEPOINT failed after nested transaction error: ${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }
    await execute(`RELEASE SAVEPOINT ${savepoint}`);
    parent.callbacks.push(...child.callbacks);
    return result;
  }

  /**
   * Makes `connection` the active transaction for `owner` while `callback`
   * runs, for a transaction the caller owns (and commits) itself. Queued
   * callbacks run once `callback`'s promise resolves (outside the scope) and
   * are dropped if it rejects. A synchronous callback cannot be awaited, so
   * anything it queued is dropped with a warning.
   */
  runSeeded<T>(owner: K, connection: C, callback: () => T): T {
    const root = this.createRoot(connection);
    const result = this.run(owner, root, callback);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(async (value) => {
        await runAfterCommitCallbacks(root.callbacks);
        return value;
      }) as unknown as T;
    }
    if (root.callbacks.length > 0) {
      console.warn(
        `[duraflows] ${root.callbacks.length} afterCommit callback(s) dropped: they were queued by a synchronous transaction callback, which cannot be awaited`,
      );
    }
    return result;
  }

  private storageFor(owner: K): AsyncLocalStorage<TransactionScope<C>> {
    let storage = this.storages.get(owner);
    if (!storage) {
      storage = new AsyncLocalStorage<TransactionScope<C>>();
      this.storages.set(owner, storage);
    }
    return storage;
  }
}
