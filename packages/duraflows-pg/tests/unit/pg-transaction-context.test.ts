import { describe, it, expect, vi } from "vitest";
import { PgTransactionContext } from "../../src/pg-transaction-context.js";
import type { Pool, PoolClient } from "pg";

function mockPoolClient(): PoolClient {
  return {
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("PgTransactionContext", () => {
  it("getClient() returns undefined outside run()", () => {
    const pool = {} as Pool;
    expect(PgTransactionContext.getClient(pool)).toBeUndefined();
  });

  it("getClient() returns the client inside run()", () => {
    const pool = {} as Pool;
    const client = mockPoolClient();
    PgTransactionContext.run(pool, client, () => {
      expect(PgTransactionContext.getClient(pool)).toBe(client);
    });
  });

  it("returns the callback result from run()", () => {
    const pool = {} as Pool;
    const client = mockPoolClient();
    const result = PgTransactionContext.run(pool, client, () => 42);
    expect(result).toBe(42);
  });

  it("getClient() returns undefined after run() completes", () => {
    const pool = {} as Pool;
    const client = mockPoolClient();
    PgTransactionContext.run(pool, client, () => {});
    expect(PgTransactionContext.getClient(pool)).toBeUndefined();
  });

  it("scopes context per pool", () => {
    const poolA = {} as Pool;
    const poolB = {} as Pool;
    const client = {} as PoolClient;

    PgTransactionContext.run(poolA, client, () => {
      expect(PgTransactionContext.getClient(poolA)).toBe(client);
      expect(PgTransactionContext.getClient(poolB)).toBeUndefined();
    });
  });
});
