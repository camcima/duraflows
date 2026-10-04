import { describe, it, expect, vi } from "vitest";
import type { Kysely, Transaction } from "kysely";
import {
  KyselyWorkflowIdempotencyStore,
  KyselyTransactionContext,
  kyselyWorkflowProviders,
  kyselyWorkflowProvidersFromTransaction,
} from "../../src/index.js";
import type { WorkflowDatabase } from "../../src/index.js";
import type { WorkflowExecutionResult } from "@duraflows/core";

const result: WorkflowExecutionResult = {
  outcome: "success",
  fromState: "new",
  toState: "done",
  commandResults: [],
  historyUuid: "history",
};

describe("KyselyWorkflowIdempotencyStore", () => {
  it("requires the matching database's transaction for every operation", async () => {
    const db = {} as Kysely<WorkflowDatabase>;
    const store = new KyselyWorkflowIdempotencyStore(db);
    await expect(store.find("instance", "key")).rejects.toThrow("active transaction");
    await expect(
      store.reserve({ workflowInstanceUuid: "instance", key: "key", eventName: "Submit" }),
    ).rejects.toThrow();
    await expect(store.complete("instance", "key", result)).rejects.toThrow();
    await KyselyTransactionContext.run(
      {} as Kysely<WorkflowDatabase>,
      {} as Transaction<WorkflowDatabase>,
      async () => {
        await expect(store.find("instance", "key")).rejects.toThrow("active transaction");
      },
    );
  });

  it("uses the transaction for exact lookup, reservation, and one-time completion", async () => {
    const db = {} as Kysely<WorkflowDatabase>;
    const builder = {
      selectFrom: vi.fn(),
      selectAll: vi.fn(),
      where: vi.fn(),
      insertInto: vi.fn(),
      values: vi.fn(),
      updateTable: vi.fn(),
      set: vi.fn(),
      execute: vi.fn(),
      executeTakeFirst: vi.fn(),
    };
    for (const name of ["selectFrom", "selectAll", "where", "insertInto", "values", "updateTable", "set"] as const)
      builder[name].mockReturnValue(builder);
    const transaction = builder as unknown as Transaction<WorkflowDatabase>;
    const store = new KyselyWorkflowIdempotencyStore(db);
    await KyselyTransactionContext.run(db, transaction, async () => {
      expect(await store.find("instance", "missing")).toBeNull();
      builder.executeTakeFirst.mockResolvedValueOnce({
        workflow_instance_uuid: "instance",
        idempotency_key: "key",
        event_name: "Submit",
        fingerprint: null,
        result_json: result,
        created_at: new Date("2026-10-03"),
      });
      expect(await store.find("instance", "key")).toMatchObject({ key: "key", fingerprint: undefined, result });
      builder.executeTakeFirst.mockResolvedValueOnce({
        workflow_instance_uuid: "instance",
        idempotency_key: "key",
        event_name: "Submit",
        fingerprint: "input",
        result_json: null,
        created_at: new Date(),
      });
      expect(await store.find("instance", "key")).toMatchObject({ fingerprint: "input", result: null });
      await store.reserve({ workflowInstanceUuid: "instance", key: "key", eventName: "Submit" });
      expect(builder.values).toHaveBeenLastCalledWith({
        workflow_instance_uuid: "instance",
        idempotency_key: "key",
        event_name: "Submit",
        fingerprint: null,
      });
      await store.reserve({ workflowInstanceUuid: "instance", key: "key", eventName: "Submit", fingerprint: "input" });
      builder.executeTakeFirst.mockResolvedValueOnce({ numUpdatedRows: 1n });
      await store.complete("instance", "key", result);
      expect(builder.set).toHaveBeenLastCalledWith({ result_json: JSON.stringify(result) });
      expect(builder.where).toHaveBeenCalledWith("result_json", "is", null);
      builder.executeTakeFirst.mockResolvedValueOnce({ numUpdatedRows: 0n });
      await expect(store.complete("instance", "key", result)).rejects.toThrow("missing or already completed");
    });
  });

  it("enables the optional capability in both factory styles", () => {
    const db = {} as Kysely<WorkflowDatabase>;
    const trx = {} as Transaction<WorkflowDatabase>;
    expect(kyselyWorkflowProviders(db).idempotencyStore).toBeUndefined();
    expect(kyselyWorkflowProviders(db, { idempotency: true }).idempotencyStore).toBeInstanceOf(
      KyselyWorkflowIdempotencyStore,
    );
    expect(kyselyWorkflowProvidersFromTransaction(trx).idempotencyStore).toBeUndefined();
    expect(kyselyWorkflowProvidersFromTransaction(trx, { idempotency: true }).idempotencyStore).toBeInstanceOf(
      KyselyWorkflowIdempotencyStore,
    );
  });
});
