import { describe, it, expect, vi } from "vitest";
import { KyselyTransactionRunner } from "../../src/kysely-transaction-runner.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import { kyselyWorkflowProvidersFromTransaction } from "../../src/index.js";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

type MockTransaction = Transaction<WorkflowDatabase>;

function createMockDb() {
  const mockTrx = {} as MockTransaction;
  const db = {
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn(async (callback: (trx: MockTransaction) => Promise<unknown>) => callback(mockTrx)),
    }),
  } as unknown as Kysely<WorkflowDatabase>;
  return { db, mockTrx };
}

describe("kysely transaction context isolation (AR-01)", () => {
  it("db A's transaction is invisible to db B's context", async () => {
    const a = createMockDb();
    const b = createMockDb();
    const runnerA = new KyselyTransactionRunner(a.db);

    await runnerA.runInTransaction(async () => {
      expect(KyselyTransactionContext.getTransaction(a.db)).toBe(a.mockTrx);
      expect(KyselyTransactionContext.getTransaction(b.db)).toBeUndefined();
    });
  });

  it("a nested runner for db B opens its own transaction inside db A's", async () => {
    const a = createMockDb();
    const b = createMockDb();
    const runnerA = new KyselyTransactionRunner(a.db);
    const runnerB = new KyselyTransactionRunner(b.db);

    await runnerA.runInTransaction(async () => {
      await runnerB.runInTransaction(async () => {
        expect(KyselyTransactionContext.getTransaction(b.db)).toBe(b.mockTrx);
      });
    });

    expect(b.db.transaction).toHaveBeenCalledTimes(1);
  });

  it("providers pre-bound to a transaction ignore an unrelated ambient transaction", async () => {
    const outer = createMockDb();
    const boundTrx = {} as MockTransaction;
    const providers = kyselyWorkflowProvidersFromTransaction(boundTrx);
    const outerRunner = new KyselyTransactionRunner(outer.db);

    await outerRunner.runInTransaction(async () => {
      await providers.transactionRunner.runInTransaction(async () => {
        // The bound trx — not outer.mockTrx — must be the active context.
        expect(KyselyTransactionContext.getTransaction(boundTrx)).toBe(boundTrx);
      });
    });
  });
});
