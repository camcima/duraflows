/**
 * Type-level regression test: verifies that factory functions and
 * KyselyTransactionContext accept Kysely<AppDb & WorkflowDatabase>
 * (intersection-typed consumer databases).
 *
 * The runtime assertions here are trivial — the real value is caught
 * by `npm run typecheck` (vitest typecheck), which validates these
 * type-level assertions without stripping types.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowPersistenceProvider } from "@duraflows/core";
import {
  kyselyWorkflowProviders,
  kyselyWorkflowProvidersFromTransaction,
  KyselyTransactionContext,
} from "../../src/index.js";
import type { WorkflowDatabase } from "../../src/kysely-database.js";

// Consumer's app database — extends WorkflowDatabase with app tables
interface OrdersTable {
  id: string;
  status: string;
}

interface AppDb extends WorkflowDatabase {
  orders: OrdersTable;
}

describe("Kysely type invariance", () => {
  it("kyselyWorkflowProviders accepts Kysely<AppDb>", () => {
    expectTypeOf(kyselyWorkflowProviders<AppDb>).parameter(0).toMatchTypeOf<Kysely<AppDb>>();
    expectTypeOf(kyselyWorkflowProviders<AppDb>).returns.toMatchTypeOf<WorkflowPersistenceProvider>();
  });

  it("kyselyWorkflowProvidersFromTransaction accepts Transaction<AppDb>", () => {
    expectTypeOf(kyselyWorkflowProvidersFromTransaction<AppDb>)
      .parameter(0)
      .toMatchTypeOf<Transaction<AppDb>>();
  });

  it("KyselyTransactionContext.run accepts Transaction<AppDb>", () => {
    // run<T, DB> — verify it accepts AppDb-typed transactions
    expectTypeOf(KyselyTransactionContext.run<void, AppDb>)
      .parameter(0)
      .toMatchTypeOf<Transaction<AppDb>>();
  });

  it("narrow WorkflowDatabase case still works", () => {
    expectTypeOf(kyselyWorkflowProviders<WorkflowDatabase>)
      .parameter(0)
      .toMatchTypeOf<Kysely<WorkflowDatabase>>();
  });
});
