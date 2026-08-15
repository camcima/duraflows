import type { Kysely, Transaction } from "kysely";
import type { WorkflowTransactionRunner } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";
import type { WorkflowDatabase } from "./kysely-database.js";
import { KyselyTransactionContext } from "./kysely-transaction-context.js";

/**
 * Transaction-scoped PostgreSQL timeouts.
 *
 * Both settings are optional and both default to unset: when neither is
 * supplied the runner issues no extra statement at all, leaving the session and
 * server defaults exactly as they were before this option existed.
 */
export interface KyselyTransactionRunnerOptions {
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

/** A PostgreSQL setting name paired with the value it is given for one transaction. */
type TimeoutSetting = readonly [setting: string, value: string];

/**
 * Rejects anything that is not a finite, non-negative integer. Called at
 * construction time so an invalid value can never reach the database.
 */
function assertTimeoutMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowError(`${name} must be a non-negative integer number of milliseconds, got ${value}`);
  }
}

/**
 * Resolves the configured timeouts into `(setting, value)` pairs, or an empty
 * list when neither is configured.
 */
function buildTimeoutSettings(options: KyselyTransactionRunnerOptions): readonly TimeoutSetting[] {
  const settings: TimeoutSetting[] = [];
  if (options.lockTimeoutMs !== undefined) {
    assertTimeoutMs(options.lockTimeoutMs, "lockTimeoutMs");
    settings.push(["lock_timeout", String(options.lockTimeoutMs)]);
  }
  if (options.statementTimeoutMs !== undefined) {
    assertTimeoutMs(options.statementTimeoutMs, "statementTimeoutMs");
    settings.push(["statement_timeout", String(options.statementTimeoutMs)]);
  }
  return settings;
}

export class KyselyTransactionRunner implements WorkflowTransactionRunner {
  private readonly timeoutSettings: readonly TimeoutSetting[];

  constructor(
    private readonly db: Kysely<WorkflowDatabase>,
    options: KyselyTransactionRunnerOptions = {},
  ) {
    this.timeoutSettings = buildTimeoutSettings(options);
  }

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    const existing = KyselyTransactionContext.getTransaction(this.db);
    if (existing) {
      return callback();
    }

    return this.db.transaction().execute(async (trx) => {
      await this.applyTimeouts(trx);
      return KyselyTransactionContext.run(this.db, trx, callback);
    });
  }

  /**
   * Applies the configured timeouts to `trx` as transaction-local settings, so
   * they are reverted on COMMIT/ROLLBACK and never leak to other users of the
   * shared pool.
   *
   * `set_config(name, value, is_local = true)` is the function form of
   * `SET LOCAL`, reached through the query builder rather than kysely's `sql`
   * template on purpose: this package imports kysely for types only, which is
   * what keeps its CommonJS build loadable (kysely itself is ESM-only). Both
   * arguments are bound parameters, so no value is ever interpolated into SQL.
   */
  private async applyTimeouts(trx: Transaction<WorkflowDatabase>): Promise<void> {
    for (const [setting, value] of this.timeoutSettings) {
      await trx
        .selectNoFrom((eb) =>
          eb.fn<string>("set_config", [eb.val(setting), eb.val(value), eb.val(true)]).as("set_config"),
        )
        .executeTakeFirst();
    }
  }
}
