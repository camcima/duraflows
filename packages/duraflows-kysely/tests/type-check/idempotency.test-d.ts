import { describe, it, expectTypeOf } from "vitest";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowPersistenceProvider, WorkflowIdempotencyStore } from "@duraflows/core";
import {
  kyselyWorkflowProviders,
  kyselyWorkflowProvidersFromTransaction,
  KyselyWorkflowIdempotencyStore,
  type WorkflowDatabase,
  type WorkflowDatabaseWithIdempotency,
} from "../../src/index.js";

interface OldAppDatabase extends WorkflowDatabase {
  orders: { id: string };
}
interface NewAppDatabase extends WorkflowDatabaseWithIdempotency {
  orders: { id: string };
}
declare const oldDb: Kysely<OldAppDatabase>;
declare const newDb: Kysely<NewAppDatabase>;
declare const transaction: Transaction<OldAppDatabase>;

describe("optional idempotency type compatibility", () => {
  it("preserves existing consumers and accepts extended schemas", () => {
    expectTypeOf(kyselyWorkflowProviders(oldDb)).toMatchTypeOf<WorkflowPersistenceProvider>();
    expectTypeOf(kyselyWorkflowProviders(oldDb, { idempotency: true })).toMatchTypeOf<WorkflowPersistenceProvider>();
    expectTypeOf(kyselyWorkflowProviders(newDb, { idempotency: true }).idempotencyStore).toEqualTypeOf<
      WorkflowIdempotencyStore | undefined
    >();
    expectTypeOf(
      kyselyWorkflowProvidersFromTransaction(transaction, { idempotency: true }),
    ).toMatchTypeOf<WorkflowPersistenceProvider>();
    expectTypeOf(new KyselyWorkflowIdempotencyStore(newDb)).toMatchTypeOf<WorkflowIdempotencyStore>();
  });
});
