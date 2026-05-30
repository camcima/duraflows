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

    let observed: unknown;
    await providers.transactionRunner.runInTransaction(async () => {
      observed = KyselyTransactionContext.getTransaction();
    });

    expect(observed).toBe(trx);
  });

  it("transactionRunner.runInTransaction reuses an outer transaction context without re-installing", async () => {
    const outerTrx = createMockTransaction();
    const innerTrx = createMockTransaction();
    const providers = kyselyWorkflowProvidersFromTransaction(innerTrx);

    const callback = vi.fn(async () => KyselyTransactionContext.getTransaction());

    // Simulate being called inside an existing outer transaction context.
    const observed = await KyselyTransactionContext.run(outerTrx, () =>
      providers.transactionRunner.runInTransaction(callback),
    );

    expect(callback).toHaveBeenCalledOnce();
    // Outer context wins — the from-transaction runner short-circuits.
    expect(observed).toBe(outerTrx);
  });
});
