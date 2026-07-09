import { describe, it, expect } from "vitest";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

function mockTransaction(): Transaction<WorkflowDatabase> {
  return {} as Transaction<WorkflowDatabase>;
}

describe("KyselyTransactionContext", () => {
  it("getTransaction() returns undefined outside run()", () => {
    const owner = {} as Kysely<WorkflowDatabase>;
    expect(KyselyTransactionContext.getTransaction(owner)).toBeUndefined();
  });

  it("getTransaction() returns the transaction inside run()", () => {
    const owner = {} as Kysely<WorkflowDatabase>;
    const trx = mockTransaction();
    KyselyTransactionContext.run(owner, trx, () => {
      expect(KyselyTransactionContext.getTransaction(owner)).toBe(trx);
    });
  });

  it("returns the callback result from run()", () => {
    const owner = {} as Kysely<WorkflowDatabase>;
    const trx = mockTransaction();
    const result = KyselyTransactionContext.run(owner, trx, () => 42);
    expect(result).toBe(42);
  });

  it("getTransaction() returns undefined after run() completes", () => {
    const owner = {} as Kysely<WorkflowDatabase>;
    const trx = mockTransaction();
    KyselyTransactionContext.run(owner, trx, () => {});
    expect(KyselyTransactionContext.getTransaction(owner)).toBeUndefined();
  });

  it("scopes context per owner", () => {
    const ownerA = {} as Kysely<WorkflowDatabase>;
    const ownerB = {} as Kysely<WorkflowDatabase>;
    const trx = mockTransaction();

    KyselyTransactionContext.run(ownerA, trx, () => {
      expect(KyselyTransactionContext.getTransaction(ownerA)).toBe(trx);
      expect(KyselyTransactionContext.getTransaction(ownerB)).toBeUndefined();
    });
  });
});
