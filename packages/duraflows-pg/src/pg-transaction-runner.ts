import type { Pool } from "pg";
import type { AfterCommitCallback, WorkflowTransactionRunner } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import { pgTransactionScopes, runOwnedPgTransaction } from "./pg-transaction-context.js";

/**
 * Transaction-scoped PostgreSQL timeouts.
 *
 * Both settings are optional and both default to unset: when neither is
 * supplied the runner emits no `SET LOCAL` at all, leaving the session and
 * server defaults exactly as they were before this option existed.
 */
export interface PgTransactionRunnerOptions {
  /**
   * `lock_timeout` in milliseconds -- how long a statement waits for a row lock
   * before it aborts. This is the recommended setting: it bounds the blocking
   * `SELECT ... FOR UPDATE` behind `lockByUuid()`, so a stuck lock holder cannot
   * hang a `triggerEvent()` call indefinitely while it keeps a pooled connection
   * checked out. `0` disables the timeout (PostgreSQL's own default).
   */
  lockTimeoutMs?: number;

  /**
   * `statement_timeout` in milliseconds -- how long any single statement may run
   * before it aborts. Deliberately unset by default: commands run inside the
   * same transaction and may legitimately issue slow statements on the shared
   * connection, and aborting one of those rolls the whole transition back.
   * `0` disables the timeout (PostgreSQL's own default).
   */
  statementTimeoutMs?: number;
}

/**
 * Rejects anything that is not a finite, non-negative integer. Called at
 * construction time so an invalid value can never reach the SQL text below.
 */
function assertTimeoutMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowError(`${name} must be a non-negative integer number of milliseconds, got ${value}`);
  }
}

/**
 * Builds the `SET LOCAL` statements for the configured timeouts, or an empty
 * list when neither is configured. `SET LOCAL` does not accept bind parameters,
 * so the value is interpolated -- which is safe only because `assertTimeoutMs`
 * has already proven it is a plain non-negative integer.
 */
function buildTimeoutStatements(options: PgTransactionRunnerOptions): readonly string[] {
  const statements: string[] = [];
  if (options.lockTimeoutMs !== undefined) {
    assertTimeoutMs(options.lockTimeoutMs, "lockTimeoutMs");
    statements.push(`SET LOCAL lock_timeout = ${options.lockTimeoutMs}`);
  }
  if (options.statementTimeoutMs !== undefined) {
    assertTimeoutMs(options.statementTimeoutMs, "statementTimeoutMs");
    statements.push(`SET LOCAL statement_timeout = ${options.statementTimeoutMs}`);
  }
  return statements;
}

export class PgTransactionRunner implements WorkflowTransactionRunner {
  private readonly timeoutStatements: readonly string[];

  constructor(
    private readonly pool: Pool,
    options: PgTransactionRunnerOptions = {},
  ) {
    this.timeoutStatements = buildTimeoutStatements(options);
  }

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    const scope = pgTransactionScopes.current(this.pool);
    if (scope) {
      // Nested: a savepoint on the outer transaction's client, so a failure
      // rolls back only this call. The outer transaction's timeouts stay in force.
      return pgTransactionScopes.runInSavepoint(this.pool, scope, callback, (sql) => scope.connection.query(sql));
    }
    return runOwnedPgTransaction(this.pool, this.timeoutStatements, () => callback());
  }

  afterCommit(callback: AfterCommitCallback): void {
    pgTransactionScopes.afterCommit(this.pool, callback);
  }
}
