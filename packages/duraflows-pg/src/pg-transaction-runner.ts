import type { Pool } from "pg";
import type { WorkflowTransactionRunner } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionContext } from "./pg-transaction-context.js";

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
    // If already within a transaction, reuse the existing client
    const existingClient = PgTransactionContext.getClient(this.pool);
    if (existingClient) {
      return callback();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // `SET LOCAL` is scoped to this transaction, so the settings are reverted
      // on COMMIT/ROLLBACK and never leak to other users of the shared pool.
      for (const statement of this.timeoutStatements) {
        await client.query(statement);
      }
      const result = await PgTransactionContext.run(this.pool, client, callback);
      await client.query("COMMIT");
      return result;
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
  }
}
