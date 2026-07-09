import { describe, it, expect, vi } from "vitest";
import { PgTransactionRunner } from "../../src/pg-transaction-runner.js";
import { PgWorkflowInstanceStore } from "../../src/pg-instance-store.js";
import type { Pool, PoolClient } from "pg";

function createMocks() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as Pool;
  return { pool, client };
}

const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

describe("pg transaction context isolation (AR-01)", () => {
  it("a store bound to pool B ignores pool A's active transaction", async () => {
    const a = createMocks();
    const b = createMocks();
    const runnerA = new PgTransactionRunner(a.pool);
    const storeB = new PgWorkflowInstanceStore(b.pool);

    await runnerA.runInTransaction(async () => {
      await storeB.findByUuid("some-uuid");
    });

    // Store B must query pool B directly — never pool A's transaction client.
    expect(b.pool.query).toHaveBeenCalledTimes(1);
    expect(calls(a.client.query)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("a nested runner for pool B opens its own transaction inside pool A's", async () => {
    const a = createMocks();
    const b = createMocks();
    const runnerA = new PgTransactionRunner(a.pool);
    const runnerB = new PgTransactionRunner(b.pool);

    await runnerA.runInTransaction(async () => {
      await runnerB.runInTransaction(async () => "inner");
    });

    expect(b.pool.connect).toHaveBeenCalledTimes(1);
    expect(calls(b.client.query)).toEqual(["BEGIN", "COMMIT"]);
    expect(calls(a.client.query)).toEqual(["BEGIN", "COMMIT"]);
  });

  it("the same pool still reuses its own active transaction (no nested BEGIN)", async () => {
    const a = createMocks();
    const runner = new PgTransactionRunner(a.pool);
    const store = new PgWorkflowInstanceStore(a.pool);

    await runner.runInTransaction(async () => {
      await runner.runInTransaction(async () => {
        await store.findByUuid("some-uuid");
      });
    });

    const clientCalls = calls(a.client.query);
    expect(clientCalls.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(clientCalls.some((sql) => sql.includes("SELECT"))).toBe(true);
    expect(a.pool.query).not.toHaveBeenCalled();
    expect(a.pool.connect).toHaveBeenCalledTimes(1);
  });
});
