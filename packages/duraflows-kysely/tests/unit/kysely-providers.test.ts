import { describe, it, expect, vi } from "vitest";
import type { Kysely, Transaction } from "kysely";
import { kyselyWorkflowProviders, kyselyWorkflowProvidersFromTransaction } from "../../src/index.js";
import { KyselyTransactionRunner } from "../../src/kysely-transaction-runner.js";
import { KyselyWorkflowInstanceStore } from "../../src/kysely-instance-store.js";
import { KyselyWorkflowHistoryStore } from "../../src/kysely-history-store.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

function createMockDb(): Kysely<WorkflowDatabase> {
  return {} as unknown as Kysely<WorkflowDatabase>;
}

function createMockTransaction(): Transaction<WorkflowDatabase> {
  return {} as unknown as Transaction<WorkflowDatabase>;
}

describe("kyselyWorkflowProviders()", () => {
  it("returns a provider bundle wired to a shared db handle", () => {
    const db = createMockDb();

    const providers = kyselyWorkflowProviders(db);

    expect(providers.transactionRunner).toBeInstanceOf(KyselyTransactionRunner);
    expect(providers.instanceStore).toBeInstanceOf(KyselyWorkflowInstanceStore);
    expect(providers.historyStore).toBeInstanceOf(KyselyWorkflowHistoryStore);
  });

  it("produces fresh instances on each call", () => {
    const db = createMockDb();

    const a = kyselyWorkflowProviders(db);
    const b = kyselyWorkflowProviders(db);

    expect(a.transactionRunner).not.toBe(b.transactionRunner);
    expect(a.instanceStore).not.toBe(b.instanceStore);
    expect(a.historyStore).not.toBe(b.historyStore);
  });
});

describe("kyselyWorkflowProvidersFromTransaction()", () => {
  it("returns providers bound to the supplied transaction", () => {
    const trx = createMockTransaction();

    const providers = kyselyWorkflowProvidersFromTransaction(trx);

    expect(providers.transactionRunner).toBeDefined();
    expect(providers.instanceStore).toBeInstanceOf(KyselyWorkflowInstanceStore);
    expect(providers.historyStore).toBeInstanceOf(KyselyWorkflowHistoryStore);
  });

  it("transactionRunner.runInTransaction installs the trx into KyselyTransactionContext", async () => {
    const trx = createMockTransaction();
    const providers = kyselyWorkflowProvidersFromTransaction(trx);
    const owner = trx as unknown as Kysely<WorkflowDatabase>;

    let observed: unknown;
    await providers.transactionRunner.runInTransaction(async () => {
      observed = KyselyTransactionContext.getTransaction(owner);
    });

    expect(observed).toBe(trx);
  });

  it("transactionRunner.runInTransaction ignores an unrelated ambient transaction (AR-01)", async () => {
    const outerDb = createMockDb();
    const outerTrx = createMockTransaction();
    const innerTrx = createMockTransaction();
    const providers = kyselyWorkflowProvidersFromTransaction(innerTrx);
    const innerOwner = innerTrx as unknown as Kysely<WorkflowDatabase>;

    const callback = vi.fn(async () => KyselyTransactionContext.getTransaction(innerOwner));

    // Simulate being called inside an unrelated ambient transaction context
    // (e.g. an outer runner bound to a different Kysely instance).
    const observed = await KyselyTransactionContext.run(outerDb, outerTrx, () =>
      providers.transactionRunner.runInTransaction(callback),
    );

    expect(callback).toHaveBeenCalledOnce();
    // The pre-bound trx must remain the active context — the ambient
    // outer transaction from another provider can never supersede it.
    expect(observed).toBe(innerTrx);
  });
});
