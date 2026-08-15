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

  const mockTrx = {
    selectNoFrom: vi.fn((callback: (eb: typeof expressionBuilder) => unknown) => {
      callback(expressionBuilder);
      return { executeTakeFirst: vi.fn().mockResolvedValue(undefined) };
    }),
  } as unknown as MockTransaction;

  const db = {
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn(async (callback: (trx: MockTransaction) => Promise<unknown>) => callback(mockTrx)),
    }),
  } as unknown as Kysely<WorkflowDatabase>;

  return { db, mockTrx, setConfigCalls };
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

  it("reuses existing transaction context (no nested transaction)", async () => {
    const { db } = createMockDb();
    const runner = new KyselyTransactionRunner(db);

    const existingTrx = {} as MockTransaction;

    const result = await KyselyTransactionContext.run(db, existingTrx, () =>
      runner.runInTransaction(async () => {
        expect(KyselyTransactionContext.getTransaction(db)).toBe(existingTrx);
        return "nested";
      }),
    );

    expect(result).toBe("nested");
    // db.transaction should NOT be called — we reused the existing context
    expect(db.transaction).not.toHaveBeenCalled();
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
    const existingTrx = {} as MockTransaction;

    await KyselyTransactionContext.run(db, existingTrx, () => runner.runInTransaction(async () => "nested"));

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
