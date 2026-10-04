import { describe, it, expect } from "vitest";
import type { WorkflowIdempotencyStore, WorkflowTransactionRunner, WorkflowExecutionResult } from "../index.js";

export interface IdempotencyStoreConformanceHarness {
  /** Fresh transactional store and an existing instance, with its lock held for store calls by withInstanceLock. */
  setup(): Promise<{
    store: WorkflowIdempotencyStore;
    transactionRunner: WorkflowTransactionRunner;
    instanceUuid: string;
    withInstanceLock: <T>(work: () => Promise<T>) => Promise<T>;
    teardown: () => Promise<void>;
  }>;
}

/** Shared contract tests; real multi-connection locking races must be tested separately. */
export function runIdempotencyStoreConformance(label: string, harness: IdempotencyStoreConformanceHarness): void {
  describe(`WorkflowIdempotencyStore conformance: ${label}`, () => {
    const result: WorkflowExecutionResult = {
      outcome: "success",
      fromState: "new",
      toState: "done",
      commandResults: [{ ok: true }],
      historyUuid: "history-1",
    };

    it("requires an active transaction for every operation", async () => {
      const h = await harness.setup();
      try {
        await expect(h.store.find(h.instanceUuid, "key")).rejects.toThrow();
        await expect(
          h.store.reserve({ workflowInstanceUuid: h.instanceUuid, key: "key", eventName: "Submit" }),
        ).rejects.toThrow();
        await expect(h.store.complete(h.instanceUuid, "key", result)).rejects.toThrow();
      } finally {
        await h.teardown();
      }
    });

    it("round-trips a reservation and immutable completed JSON result", async () => {
      const h = await harness.setup();
      try {
        await h.withInstanceLock(async () => {
          expect(await h.store.find(h.instanceUuid, "key")).toBeNull();
          await h.store.reserve({
            workflowInstanceUuid: h.instanceUuid,
            key: "key",
            eventName: "Submit",
            fingerprint: "input",
          });
          expect(await h.store.find(h.instanceUuid, "key")).toMatchObject({
            result: null,
            fingerprint: "input",
            createdAt: expect.any(Date),
          });
          await h.store.complete(h.instanceUuid, "key", result);
          expect((await h.store.find(h.instanceUuid, "key"))!.result).toEqual(result);
          await expect(h.store.complete(h.instanceUuid, "key", { ...result, toState: "changed" })).rejects.toThrow();
          expect((await h.store.find(h.instanceUuid, "key"))!.result).toEqual(result);
          await expect(h.store.complete(h.instanceUuid, "missing", result)).rejects.toThrow();
        });
      } finally {
        await h.teardown();
      }
    });

    it("compares opaque keys exactly and round-trips an omitted fingerprint", async () => {
      const h = await harness.setup();
      try {
        await h.withInstanceLock(async () => {
          for (const key of ["Key", "key", " key", "é", "e\u0301"]) {
            await h.store.reserve({ workflowInstanceUuid: h.instanceUuid, key, eventName: "Submit" });
            await h.store.complete(h.instanceUuid, key, result);
            const record = await h.store.find(h.instanceUuid, key);
            expect(record).toMatchObject({ key, result });
            expect(record!.fingerprint).toBeUndefined();
          }
        });
      } finally {
        await h.teardown();
      }
    });

    it("rolls back completed receipts with the enclosing transaction", async () => {
      const h = await harness.setup();
      try {
        await expect(
          h.withInstanceLock(async () => {
            await h.store.reserve({ workflowInstanceUuid: h.instanceUuid, key: "key", eventName: "Submit" });
            await h.store.complete(h.instanceUuid, "key", result);
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        await h.withInstanceLock(async () => {
          expect(await h.store.find(h.instanceUuid, "key")).toBeNull();
        });
      } finally {
        await h.teardown();
      }
    });

    it("isolates a failed nested reservation and never overwrites an existing one", async () => {
      const h = await harness.setup();
      try {
        await h.withInstanceLock(async () => {
          await h.store.reserve({ workflowInstanceUuid: h.instanceUuid, key: "key", eventName: "Submit" });
          await expect(
            h.transactionRunner.runInTransaction(async () => {
              await h.store.reserve({ workflowInstanceUuid: h.instanceUuid, key: "key", eventName: "Changed" });
            }),
          ).rejects.toThrow();
          expect((await h.store.find(h.instanceUuid, "key"))!.eventName).toBe("Submit");
          await expect(
            h.transactionRunner.runInTransaction(async () => {
              await h.store.reserve({ workflowInstanceUuid: h.instanceUuid, key: "nested", eventName: "Submit" });
              await h.store.complete(h.instanceUuid, "nested", result);
              throw new Error("nested rollback");
            }),
          ).rejects.toThrow("nested rollback");
          expect(await h.store.find(h.instanceUuid, "nested")).toBeNull();
          await h.store.complete(h.instanceUuid, "key", result);
        });
      } finally {
        await h.teardown();
      }
    });
  });
}
