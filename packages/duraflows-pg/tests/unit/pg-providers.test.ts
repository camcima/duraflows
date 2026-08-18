import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { pgWorkflowProviders } from "../../src/index.js";
import { PgTransactionRunner } from "../../src/pg-transaction-runner.js";
import { PgWorkflowInstanceStore } from "../../src/pg-instance-store.js";
import { PgWorkflowHistoryStore } from "../../src/pg-history-store.js";
import { PgWorkflowDefinitionStore } from "../../src/pg-definition-store.js";

function createMockPool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
}

function createConnectablePool(): { pool: Pool; client: PoolClient } {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return { pool, client };
}

describe("pgWorkflowProviders()", () => {
  it("returns a provider bundle wired to a shared pool", () => {
    const pool = createMockPool();

    const providers = pgWorkflowProviders(pool);

    expect(providers.transactionRunner).toBeInstanceOf(PgTransactionRunner);
    expect(providers.instanceStore).toBeInstanceOf(PgWorkflowInstanceStore);
    expect(providers.historyStore).toBeInstanceOf(PgWorkflowHistoryStore);
    expect(providers.definitionStore).toBeInstanceOf(PgWorkflowDefinitionStore);
  });

  it("produces fresh instances on each call (no shared mutable state)", () => {
    const pool = createMockPool();

    const a = pgWorkflowProviders(pool);
    const b = pgWorkflowProviders(pool);

    expect(a.transactionRunner).not.toBe(b.transactionRunner);
    expect(a.instanceStore).not.toBe(b.instanceStore);
    expect(a.historyStore).not.toBe(b.historyStore);
    expect(a.definitionStore).not.toBe(b.definitionStore);
  });

  it("emits no timeout statements when called without options (default behaviour)", async () => {
    const { pool, client } = createConnectablePool();

    await pgWorkflowProviders(pool).transactionRunner.runInTransaction(async () => undefined);

    expect((client.query as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual(["BEGIN", "COMMIT"]);
  });

  it("forwards timeout options to the transaction runner", async () => {
    const { pool, client } = createConnectablePool();

    await pgWorkflowProviders(pool, {
      lockTimeoutMs: 3000,
      statementTimeoutMs: 30000,
    }).transactionRunner.runInTransaction(async () => undefined);

    expect((client.query as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = 3000",
      "SET LOCAL statement_timeout = 30000",
      "COMMIT",
    ]);
  });

  it("rejects an invalid timeout at construction time", () => {
    const pool = createMockPool();

    expect(() => pgWorkflowProviders(pool, { lockTimeoutMs: -1 })).toThrow(
      /lockTimeoutMs must be a non-negative integer/,
    );
  });
});
