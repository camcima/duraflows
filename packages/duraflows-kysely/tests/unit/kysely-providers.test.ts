import { describe, it, expect, vi } from "vitest";
import type { Kysely, Transaction } from "kysely";
import { kyselyWorkflowProviders, kyselyWorkflowProvidersFromTransaction } from "../../src/index.js";
import { KyselyTransactionRunner } from "../../src/kysely-transaction-runner.js";
import { KyselyWorkflowInstanceStore } from "../../src/kysely-instance-store.js";
import { KyselyWorkflowHistoryStore } from "../../src/kysely-history-store.js";
import { KyselyWorkflowDefinitionStore } from "../../src/kysely-definition-store.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

function createMockDb(): Kysely<WorkflowDatabase> {
  return {} as unknown as Kysely<WorkflowDatabase>;
}

function createMockTransaction(): Transaction<WorkflowDatabase> {
  return {} as unknown as Transaction<WorkflowDatabase>;
}

/** A `set_config(...)` call captured off the fake expression builder. */
interface SetConfigCall {
  name: string;
  args: readonly unknown[];
}

/**
 * A mock db whose `transaction()` runs the callback against a transaction that
 * records the `set_config(...)` calls the runner builds.
 */
function createTransactableDb() {
  const setConfigCalls: SetConfigCall[] = [];

  const expressionBuilder = {
    fn: (name: string, args: readonly unknown[]) => ({
      as: (_alias: string) => {
        setConfigCalls.push({ name, args });
        return {};
      },
    }),
    val: (value: unknown) => value,
  };

  const mockTrx = {
    selectNoFrom: vi.fn((callback: (eb: typeof expressionBuilder) => unknown) => {
      callback(expressionBuilder);
      return { executeTakeFirst: vi.fn().mockResolvedValue(undefined) };
    }),
  } as unknown as Transaction<WorkflowDatabase>;

  const db = {
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn(async (callback: (trx: Transaction<WorkflowDatabase>) => Promise<unknown>) => callback(mockTrx)),
    }),
  } as unknown as Kysely<WorkflowDatabase>;

  return { db, mockTrx, setConfigCalls };
}

describe("kyselyWorkflowProviders()", () => {
  it("returns a provider bundle wired to a shared db handle", () => {
    const db = createMockDb();

    const providers = kyselyWorkflowProviders(db);

    expect(providers.transactionRunner).toBeInstanceOf(KyselyTransactionRunner);
    expect(providers.instanceStore).toBeInstanceOf(KyselyWorkflowInstanceStore);
    expect(providers.historyStore).toBeInstanceOf(KyselyWorkflowHistoryStore);
    expect(providers.definitionStore).toBeInstanceOf(KyselyWorkflowDefinitionStore);
  });

  it("produces fresh instances on each call", () => {
    const db = createMockDb();

    const a = kyselyWorkflowProviders(db);
    const b = kyselyWorkflowProviders(db);

    expect(a.transactionRunner).not.toBe(b.transactionRunner);
    expect(a.instanceStore).not.toBe(b.instanceStore);
    expect(a.historyStore).not.toBe(b.historyStore);
    expect(a.definitionStore).not.toBe(b.definitionStore);
  });

  it("emits no timeout statement when called without options (default behaviour)", async () => {
    const { db, mockTrx } = createTransactableDb();

    await kyselyWorkflowProviders(db).transactionRunner.runInTransaction(async () => undefined);

    expect(mockTrx.selectNoFrom).not.toHaveBeenCalled();
  });

  it("forwards timeout options to the transaction runner", async () => {
    const { db, setConfigCalls } = createTransactableDb();

    await kyselyWorkflowProviders(db, {
      lockTimeoutMs: 3000,
      statementTimeoutMs: 30000,
    }).transactionRunner.runInTransaction(async () => undefined);

    expect(setConfigCalls).toEqual([
      { name: "set_config", args: ["lock_timeout", "3000", true] },
      { name: "set_config", args: ["statement_timeout", "30000", true] },
    ]);
  });

  it("rejects an invalid timeout at construction time", () => {
    const db = createMockDb();

    expect(() => kyselyWorkflowProviders(db, { lockTimeoutMs: -1 })).toThrow(
      /lockTimeoutMs must be a non-negative integer/,
    );
  });
});

describe("kyselyWorkflowProvidersFromTransaction()", () => {
  it("returns providers bound to the supplied transaction", () => {
    const trx = createMockTransaction();

    const providers = kyselyWorkflowProvidersFromTransaction(trx);

    expect(providers.transactionRunner).toBeDefined();
    expect(providers.instanceStore).toBeInstanceOf(KyselyWorkflowInstanceStore);
    expect(providers.historyStore).toBeInstanceOf(KyselyWorkflowHistoryStore);
    expect(providers.definitionStore).toBeInstanceOf(KyselyWorkflowDefinitionStore);
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
