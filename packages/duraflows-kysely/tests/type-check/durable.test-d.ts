import { describe, it, expectTypeOf } from "vitest";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowPersistenceProvider, WorkflowExecutionStore, EnqueueWorkflowEventInput } from "@duraflows/core";
import {
  kyselyWorkflowProviders,
  kyselyWorkflowProvidersFromTransaction,
  KyselyWorkflowExecutionStore,
  type WorkflowDatabase,
  type WorkflowDatabaseWithExecutions,
} from "../../src/index.js";
interface OldDatabase extends WorkflowDatabase {
  orders: { id: string };
}
interface NewDatabase extends WorkflowDatabaseWithExecutions {
  orders: { id: string };
}
declare const oldDb: Kysely<OldDatabase>, newDb: Kysely<NewDatabase>, transaction: Transaction<OldDatabase>;
describe("durable execution type compatibility", () => {
  it("keeps old database interfaces compatible with the opt-in capability", () => {
    expectTypeOf(
      kyselyWorkflowProviders(oldDb, { durableExecution: true }),
    ).toMatchTypeOf<WorkflowPersistenceProvider>();
    expectTypeOf(kyselyWorkflowProviders(newDb, { durableExecution: true }).executionStore).toEqualTypeOf<
      WorkflowExecutionStore | undefined
    >();
    expectTypeOf(
      kyselyWorkflowProvidersFromTransaction(transaction, { durableExecution: true }),
    ).toMatchTypeOf<WorkflowPersistenceProvider>();
    expectTypeOf(new KyselyWorkflowExecutionStore(newDb)).toMatchTypeOf<WorkflowExecutionStore>();
    expectTypeOf<EnqueueWorkflowEventInput["idempotencyKey"]>().toEqualTypeOf<string>();
  });
});
