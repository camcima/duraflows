import { describe, it, expect, vi } from "vitest";
import { WorkflowError } from "@duraflows/core";
import { KyselyTransactionRunner } from "../../src/kysely-transaction-runner.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

type MockTransaction = Transaction<WorkflowDatabase>;

/** A `set_config(...)` call captured off the fake expression builder. */
interface SetConfigCall {
  name: string;
  args: readonly unknown[];
}

/**
 * Minimal stand-in for kysely's expression builder: records the function calls
 * the runner builds so the emitted statement can be asserted without a real
 * database (kysely never sees these objects — only the runner does).
 */
function createMockDb() {
  const setConfigCalls: SetConfigCall[] = [];

  const expressionBuilder = {
    fn: (name: string, args: readonly unknown[]) => ({
      as: (_alias: string) => {
        setConfigCalls.push({ name, args });
        return {};
      },
    }),
    val: (value: unknown) => value,
  };

  const executedSql: string[] = [];
  const mockTrx = {
    selectNoFrom: vi.fn((callback: (eb: typeof expressionBuilder) => unknown) => {
      callback(expressionBuilder);
      return { executeTakeFirst: vi.fn().mockResolvedValue(undefined) };
    }),
    executeQuery: vi.fn(async (query: { sql: string }) => {
      executedSql.push(query.sql);
      return { rows: [] };
    }),
  } as unknown as MockTransaction;

  const db = {
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn(async (callback: (trx: MockTransaction) => Promise<unknown>) => callback(mockTrx)),
    }),
  } as unknown as Kysely<WorkflowDatabase>;

  return { db, mockTrx, setConfigCalls, executedSql };
}

function createExistingTrx() {
  const executedSql: string[] = [];
  const trx = {
    executeQuery: vi.fn(async (query: { sql: string }) => {
      executedSql.push(query.sql);
      return { rows: [] };
    }),
  } as unknown as MockTransaction;
  return { trx, executedSql };
}

describe("KyselyTransactionRunner", () => {
  it("starts a transaction, runs callback, and returns result on success", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);

    const result = await runner.runInTransaction(async () => "done");

    expect(result).toBe("done");
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it("propagates errors (Kysely handles rollback)", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);

    await expect(
      runner.runInTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("runs a nested call in a savepoint on the existing transaction", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);
    const existing = createExistingTrx();

    const result = await KyselyTransactionContext.run(db, existing.trx, () =>
      runner.runInTransaction(async () => {
        expect(KyselyTransactionContext.getTransaction(db)).toBe(existing.trx);
        return "nested";
      }),
    );

    expect(result).toBe("nested");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(existing.executedSql).toEqual(["SAVEPOINT duraflows_sp_1", "RELEASE SAVEPOINT duraflows_sp_1"]);
  });

  it("rolls a failed nested call back to its savepoint and rethrows", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);
    const existing = createExistingTrx();

    await expect(
      KyselyTransactionContext.run(db, existing.trx, () =>
        runner.runInTransaction(async () => {
          throw new Error("inner boom");
        }),
      ),
    ).rejects.toThrow("inner boom");

    expect(existing.executedSql).toEqual([
      "SAVEPOINT duraflows_sp_1",
      "ROLLBACK TO SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
    ]);
  });

  it("runs afterCommit callbacks after the kysely transaction resolves", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);
    const order: string[] = [];

    await runner.runInTransaction(async () => {
      runner.afterCommit(async () => {
        order.push("callback");
      });
      order.push("body");
    });

    expect(order).toEqual(["body", "callback"]);
  });

  it("does not run afterCommit callbacks when the commit fails", async () => {
    const { db, mockTrx } = createMockDb();
    (db.transaction as ReturnType<typeof vi.fn>).mockReturnValue({
      execute: vi.fn(async (callback: (trx: MockTransaction) => Promise<unknown>) => {
        await callback(mockTrx);
        throw new Error("could not serialize access");
      }),
    });
    const runner = new KyselyTransactionRunner(db);
    const callback = vi.fn(async () => {});

    await expect(runner.runInTransaction(async () => runner.afterCommit(callback))).rejects.toThrow(
      "could not serialize access",
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("KyselyTransactionContext.transaction fires callbacks after the transaction resolves", async () => {
    const { db, mockTrx, executedSql } = createMockDb();
    const runner = new KyselyTransactionRunner(db);
    const order: string[] = [];

    const value = await KyselyTransactionContext.transaction(db, async (trx) => {
      expect(trx).toBe(mockTrx);
      await runner.runInTransaction(async () => {
        runner.afterCommit(async () => {
          order.push("callback");
        });
      });
      order.push("body done");
      return 7;
    });

    expect(value).toBe(7);
    expect(order).toEqual(["body done", "callback"]);
    // The owned transaction ends with the aborted-transaction probe before COMMIT.
    expect(executedSql).toEqual(["SAVEPOINT duraflows_sp_1", "RELEASE SAVEPOINT duraflows_sp_1", "SELECT 1"]);
  });

  it("KyselyTransactionContext.transaction drops its callbacks when the commit fails", async () => {
    const { db, mockTrx } = createMockDb();
    (db.transaction as ReturnType<typeof vi.fn>).mockReturnValue({
      execute: vi.fn(async (callback: (trx: MockTransaction) => Promise<unknown>) => {
        await callback(mockTrx);
        throw new Error("could not serialize access");
      }),
    });
    const runner = new KyselyTransactionRunner(db);
    const callback = vi.fn();

    await expect(
      KyselyTransactionContext.transaction(db, () => runner.runInTransaction(async () => runner.afterCommit(callback))),
    ).rejects.toThrow("could not serialize access");
    expect(callback).not.toHaveBeenCalled();
  });

  it("KyselyTransactionContext.transaction applies none of a runner's timeouts", async () => {
    const { db, setConfigCalls } = createMockDb();
    const runner = new KyselyTransactionRunner(db, { lockTimeoutMs: 3000, statementTimeoutMs: 5000 });

    await KyselyTransactionContext.transaction(db, () => runner.runInTransaction(async () => "nested"));

    expect(setConfigCalls).toEqual([]);
  });

  it("gives sibling nested calls distinct savepoint names", async () => {
    const { db, executedSql } = createMockDb();
    const runner = new KyselyTransactionRunner(db);

    await runner.runInTransaction(async () => {
      await runner.runInTransaction(async () => "first");
      await runner.runInTransaction(async () => "second");
    });

    expect(executedSql).toEqual([
      "SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
      "SAVEPOINT duraflows_sp_2",
      "RELEASE SAVEPOINT duraflows_sp_2",
      "SELECT 1",
    ]);
  });

  it("rejects and drops its callbacks when PostgreSQL has already aborted the transaction", async () => {
    const { db, mockTrx } = createMockDb();
    (mockTrx.executeQuery as ReturnType<typeof vi.fn>).mockImplementation(async (query: { sql: string }) => {
      if (query.sql === "SELECT 1") {
        throw new Error("current transaction is aborted, commands ignored until end of transaction block");
      }
      return { rows: [] };
    });
    const runner = new KyselyTransactionRunner(db);
    const callback = vi.fn(async () => {});

    const outcome = runner.runInTransaction(async () => runner.afterCommit(callback));

    await expect(outcome).rejects.toBeInstanceOf(WorkflowError);
    await expect(outcome).rejects.toThrow(
      "COMMIT was rolled back by PostgreSQL because an earlier statement in the transaction failed",
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("afterCommit outside a transaction throws WorkflowError", () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);

    expect(() => runner.afterCommit(vi.fn())).toThrow(WorkflowError);
  });

  it("KyselyTransactionContext.transaction inside an active scope joins it in a savepoint", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);
    const existing = createExistingTrx();
    const order: string[] = [];

    const value = await KyselyTransactionContext.run(db, existing.trx, async () => {
      const inner = await KyselyTransactionContext.transaction(db, async (trx) => {
        expect(trx).toBe(existing.trx);
        runner.afterCommit(async () => {
          order.push("callback");
        });
        return "inner";
      });
      expect(order).toEqual([]);
      return inner;
    });

    expect(value).toBe("inner");
    expect(db.transaction).not.toHaveBeenCalled();
    expect(existing.trx.executeQuery).toHaveBeenCalledTimes(2);
    expect(existing.executedSql).toEqual(["SAVEPOINT duraflows_sp_1", "RELEASE SAVEPOINT duraflows_sp_1"]);
    expect(order).toEqual(["callback"]);
  });

  it("KyselyTransactionContext.transaction inside an active scope rolls back only its savepoint", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);
    const existing = createExistingTrx();
    const callback = vi.fn(async () => {});

    await KyselyTransactionContext.run(db, existing.trx, async () => {
      await expect(
        KyselyTransactionContext.transaction(db, async () => {
          runner.afterCommit(callback);
          throw new Error("inner failure");
        }),
      ).rejects.toThrow("inner failure");
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(existing.executedSql).toEqual([
      "SAVEPOINT duraflows_sp_1",
      "ROLLBACK TO SAVEPOINT duraflows_sp_1",
      "RELEASE SAVEPOINT duraflows_sp_1",
    ]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("seeds KyselyTransactionContext inside the transaction callback", async () => {
    const { db, mockTrx } = createMockDb();
    const runner = new KyselyTransactionRunner(db);

    let capturedTrx: Transaction<WorkflowDatabase> | undefined;

    await runner.runInTransaction(async () => {
      capturedTrx = KyselyTransactionContext.getTransaction(db);
    });

    expect(capturedTrx).toBe(mockTrx);
  });
});

describe("KyselyTransactionRunner timeouts", () => {
  it("emits no statement when no timeouts are configured", async () => {
    const { db, mockTrx, setConfigCalls } = createMockDb();
    const runner = new KyselyTransactionRunner(db);

    await runner.runInTransaction(async () => "done");

    expect(mockTrx.selectNoFrom).not.toHaveBeenCalled();
    expect(setConfigCalls).toEqual([]);
  });

  it("emits no statement when an empty options object is passed", async () => {
    const { db, mockTrx } = createMockDb();
    const runner = new KyselyTransactionRunner(db, {});

    await runner.runInTransaction(async () => "done");

    expect(mockTrx.selectNoFrom).not.toHaveBeenCalled();
  });

  it("sets lock_timeout transaction-locally before the callback runs", async () => {
    const { db, setConfigCalls } = createMockDb();
    const runner = new KyselyTransactionRunner(db, { lockTimeoutMs: 3000 });

    await runner.runInTransaction(async () => {
      // The setting must already be in force by the time the callback's own
      // statements (lockByUuid's FOR UPDATE) run.
      expect(setConfigCalls).toEqual([{ name: "set_config", args: ["lock_timeout", "3000", true] }]);
    });
  });

  it("sets both timeouts when both are configured", async () => {
    const { db, setConfigCalls } = createMockDb();
    const runner = new KyselyTransactionRunner(db, { lockTimeoutMs: 3000, statementTimeoutMs: 30000 });

    await runner.runInTransaction(async () => "done");

    expect(setConfigCalls).toEqual([
      { name: "set_config", args: ["lock_timeout", "3000", true] },
      { name: "set_config", args: ["statement_timeout", "30000", true] },
    ]);
  });

  it("accepts 0 (PostgreSQL's own 'disabled' value)", async () => {
    const { db, setConfigCalls } = createMockDb();
    const runner = new KyselyTransactionRunner(db, { statementTimeoutMs: 0 });

    await runner.runInTransaction(async () => "done");

    expect(setConfigCalls).toEqual([{ name: "set_config", args: ["statement_timeout", "0", true] }]);
  });

  it("does not re-apply timeouts when reusing an existing transaction", async () => {
    const { db, setConfigCalls } = createMockDb();
    const runner = new KyselyTransactionRunner(db, { lockTimeoutMs: 3000 });
    const existing = createExistingTrx();

    await KyselyTransactionContext.run(db, existing.trx, () => runner.runInTransaction(async () => "nested"));

    expect(db.transaction).not.toHaveBeenCalled();
    expect(setConfigCalls).toEqual([]);
  });

  it.each([
    ["a negative value", { lockTimeoutMs: -1 }],
    ["a fractional value", { lockTimeoutMs: 1.5 }],
    ["NaN", { lockTimeoutMs: Number.NaN }],
    ["Infinity", { lockTimeoutMs: Number.POSITIVE_INFINITY }],
    ["a value beyond the safe integer range", { lockTimeoutMs: 1e21 }],
  ])("rejects %s for lockTimeoutMs at construction time", (_label, options) => {
    const { db } = createMockDb();

    expect(() => new KyselyTransactionRunner(db, options)).toThrow(WorkflowError);
    expect(() => new KyselyTransactionRunner(db, options)).toThrow(/lockTimeoutMs must be a non-negative integer/);
  });

  it("rejects an invalid statementTimeoutMs at construction time", () => {
    const { db } = createMockDb();

    expect(() => new KyselyTransactionRunner(db, { statementTimeoutMs: -5 })).toThrow(
      /statementTimeoutMs must be a non-negative integer/,
    );
  });
});
