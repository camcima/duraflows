import { describe, it, expect } from "vitest";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import type { Transaction } from "kysely";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

function mockTransaction(): Transaction<WorkflowDatabase> {
  return {} as Transaction<WorkflowDatabase>;
}

describe("KyselyTransactionContext", () => {
  it("getTransaction() returns undefined outside run()", () => {
    expect(KyselyTransactionContext.getTransaction()).toBeUndefined();
  });

  it("getTransaction() returns the transaction inside run()", () => {
    const trx = mockTransaction();
    KyselyTransactionContext.run(trx, () => {
      expect(KyselyTransactionContext.getTransaction()).toBe(trx);
    });
  });

  it("returns the callback result from run()", () => {
    const trx = mockTransaction();
    const result = KyselyTransactionContext.run(trx, () => 42);
    expect(result).toBe(42);
  });

  it("getTransaction() returns undefined after run() completes", () => {
    const trx = mockTransaction();
    KyselyTransactionContext.run(trx, () => {});
    expect(KyselyTransactionContext.getTransaction()).toBeUndefined();
  });
});
