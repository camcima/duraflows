import { describe, it, expect, vi } from "vitest";
import { KyselyTransactionRunner } from "../../src/kysely-transaction-runner.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
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
