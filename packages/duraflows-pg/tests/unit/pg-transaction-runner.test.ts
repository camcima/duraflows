import { describe, it, expect, vi } from "vitest";
import { WorkflowError } from "@duraflows/core";
import { PgTransactionRunner } from "../../src/pg-transaction-runner.js";
import { PgTransactionContext } from "../../src/pg-transaction-context.js";
import type { Pool, PoolClient } from "pg";

function createMocks() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return { pool, client };
}

function queriedSql(client: PoolClient): string[] {
  return (client.query as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
}

describe("PgTransactionRunner", () => {
  it("begins, runs callback, commits, and releases client on success", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);

    const result = await runner.runInTransaction(async () => "done");

    expect(result).toBe("done");
    const queryCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(queryCalls[0][0]).toBe("BEGIN");
    expect(queryCalls[1][0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("begins, rolls back, releases client, and rethrows on error", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);
    const error = new Error("boom");

    await expect(
      runner.runInTransaction(async () => {
        throw error;
      }),
    ).rejects.toThrow("boom");

    const queryCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(queryCalls[0][0]).toBe("BEGIN");
    expect(queryCalls[1][0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  it("reuses existing transaction context (no nested BEGIN)", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);

    // Simulate being inside an existing transaction
    const existingClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient;

    const result = await PgTransactionContext.run(pool, existingClient, () =>
      runner.runInTransaction(async () => "nested"),
    );

    expect(result).toBe("nested");
    // Pool.connect should NOT be called — we reused the existing context
    expect(pool.connect).not.toHaveBeenCalled();
    // No BEGIN/COMMIT on the nested call
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rethrows the callback error even when ROLLBACK fails, and still releases the client", async () => {
    const { pool, client } = createMocks();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [] };
    });
    const runner = new PgTransactionRunner(pool);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runner.runInTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(client.release).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rollback failed"));
    warnSpy.mockRestore();
  });
});

describe("PgTransactionRunner timeouts", () => {
  it("emits no SET LOCAL when no timeouts are configured", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool);

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("emits no SET LOCAL when an empty options object is passed", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, {});

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("emits SET LOCAL lock_timeout inside the transaction, after BEGIN and before the callback", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { lockTimeoutMs: 3000 });

    await runner.runInTransaction(async () => {
      // The setting must already be in force by the time the callback's own
      // statements (lockByUuid's FOR UPDATE) run.
      expect(queriedSql(client)).toEqual(["BEGIN", "SET LOCAL lock_timeout = 3000"]);
    });

    expect(queriedSql(client)).toEqual(["BEGIN", "SET LOCAL lock_timeout = 3000", "COMMIT"]);
  });

  it("emits both SET LOCAL statements when both timeouts are configured", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { lockTimeoutMs: 3000, statementTimeoutMs: 30000 });

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = 3000",
      "SET LOCAL statement_timeout = 30000",
      "COMMIT",
    ]);
  });

  it("accepts 0 (PostgreSQL's own 'disabled' value)", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { statementTimeoutMs: 0 });

    await runner.runInTransaction(async () => "done");

    expect(queriedSql(client)).toEqual(["BEGIN", "SET LOCAL statement_timeout = 0", "COMMIT"]);
  });

  it("does not re-emit SET LOCAL when reusing an existing transaction", async () => {
    const { pool, client } = createMocks();
    const runner = new PgTransactionRunner(pool, { lockTimeoutMs: 3000 });
    const existingClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    } as unknown as PoolClient;

    await PgTransactionContext.run(pool, existingClient, () => runner.runInTransaction(async () => "nested"));

    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(existingClient.query).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative value", { lockTimeoutMs: -1 }],
    ["a fractional value", { lockTimeoutMs: 1.5 }],
    ["NaN", { lockTimeoutMs: Number.NaN }],
    ["Infinity", { lockTimeoutMs: Number.POSITIVE_INFINITY }],
    ["a value beyond the safe integer range", { lockTimeoutMs: 1e21 }],
  ])("rejects %s for lockTimeoutMs at construction time", (_label, options) => {
    const { pool } = createMocks();

    expect(() => new PgTransactionRunner(pool, options)).toThrow(WorkflowError);
    expect(() => new PgTransactionRunner(pool, options)).toThrow(/lockTimeoutMs must be a non-negative integer/);
  });

  it("rejects an invalid statementTimeoutMs at construction time", () => {
    const { pool } = createMocks();

    expect(() => new PgTransactionRunner(pool, { statementTimeoutMs: -5 })).toThrow(
      /statementTimeoutMs must be a non-negative integer/,
    );
  });
});
