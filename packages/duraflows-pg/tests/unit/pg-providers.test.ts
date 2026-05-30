import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { pgWorkflowProviders } from "../../src/index.js";
import { PgTransactionRunner } from "../../src/pg-transaction-runner.js";
import { PgWorkflowInstanceStore } from "../../src/pg-instance-store.js";
import { PgWorkflowHistoryStore } from "../../src/pg-history-store.js";

function createMockPool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as Pool;
}

describe("pgWorkflowProviders()", () => {
  it("returns a provider bundle wired to a shared pool", () => {
    const pool = createMockPool();

    const providers = pgWorkflowProviders(pool);

    expect(providers.transactionRunner).toBeInstanceOf(PgTransactionRunner);
    expect(providers.instanceStore).toBeInstanceOf(PgWorkflowInstanceStore);
    expect(providers.historyStore).toBeInstanceOf(PgWorkflowHistoryStore);
  });

  it("produces fresh instances on each call (no shared mutable state)", () => {
    const pool = createMockPool();

    const a = pgWorkflowProviders(pool);
    const b = pgWorkflowProviders(pool);

    expect(a.transactionRunner).not.toBe(b.transactionRunner);
    expect(a.instanceStore).not.toBe(b.instanceStore);
    expect(a.historyStore).not.toBe(b.historyStore);
  });
});
