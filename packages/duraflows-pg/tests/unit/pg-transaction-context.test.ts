import { describe, it, expect, vi } from "vitest";
import { PgTransactionContext } from "../../src/pg-transaction-context.js";
import type { PoolClient } from "pg";

function mockPoolClient(): PoolClient {
  return {
    query: vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("PgTransactionContext", () => {
  it("getClient() returns undefined outside run()", () => {
    expect(PgTransactionContext.getClient()).toBeUndefined();
  });

  it("getClient() returns the client inside run()", () => {
    const client = mockPoolClient();
    PgTransactionContext.run(client, () => {
      expect(PgTransactionContext.getClient()).toBe(client);
    });
  });

  it("returns the callback result from run()", () => {
    const client = mockPoolClient();
    const result = PgTransactionContext.run(client, () => 42);
    expect(result).toBe(42);
  });

  it("getClient() returns undefined after run() completes", () => {
    const client = mockPoolClient();
    PgTransactionContext.run(client, () => {});
    expect(PgTransactionContext.getClient()).toBeUndefined();
  });
});
