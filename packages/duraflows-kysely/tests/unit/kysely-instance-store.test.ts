import { describe, it, expect, vi } from "vitest";
import { KyselyWorkflowInstanceStore } from "../../src/kysely-instance-store.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import { WorkflowError } from "@duraflows/core";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowDatabase } from "../../src/kysely-database.js";
import type { WorkflowInstance } from "@duraflows/core";

const now = new Date("2026-01-15T12:00:00.000Z");

const sampleInstance: WorkflowInstance = {
  uuid: "inst-uuid",
  workflowName: "order",
  currentState: "pending",
  version: 0,
  expiresAt: null,
  lastTransitionAt: now,
  context: { status: "new" },
  metadata: { orderId: "ORD-1" },
  createdAt: now,
  updatedAt: now,
};

const sampleRow = {
  uuid: "inst-uuid",
  workflow_name: "order",
  current_state: "pending",
  version: 0,
  expires_at: null,
  last_transition_at: now,
  context_json: { status: "new" },
  metadata_json: { orderId: "ORD-1" },
  created_at: now,
  updated_at: now,
};

// Creates a mock Kysely db that tracks method calls on the builder chain
function createMockDb(queryResult: Record<string, unknown>[] = []) {
  const executeMock = vi.fn().mockResolvedValue(queryResult);
  const executeTakeFirstMock = vi.fn().mockResolvedValue(queryResult[0] ?? undefined);

  const calls: { method: string; args: unknown[] }[] = [];

  const chainBuilder = (): Record<string, unknown> => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    const methods = [
      "insertInto",
      "values",
      "returning",
      "selectFrom",
      "selectAll",
      "where",
      "forUpdate",
      "skipLocked",
      "orderBy",
      "limit",
      "offset",
      "updateTable",
      "set",
    ];
    for (const method of methods) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      });
    }
    builder.execute = executeMock;
    builder.executeTakeFirst = executeTakeFirstMock;
    return builder;
  };

  const builder = chainBuilder();
  const db = builder as unknown as Kysely<WorkflowDatabase>;

  return { db, calls, executeMock, executeTakeFirstMock };
}

describe("KyselyWorkflowInstanceStore", () => {
  describe("create()", () => {
    it("inserts an instance with correct column values", async () => {
      const { db, calls } = createMockDb();
      const store = new KyselyWorkflowInstanceStore(db);

      await store.create(sampleInstance);

      const insertCall = calls.find((c) => c.method === "insertInto");
      expect(insertCall).toBeDefined();
      expect(insertCall!.args[0]).toBe("workflow_instances");

      const valuesCall = calls.find((c) => c.method === "values");
      expect(valuesCall).toBeDefined();
      const row = valuesCall!.args[0] as Record<string, unknown>;
      expect(row.uuid).toBe("inst-uuid");
      expect(row.workflow_name).toBe("order");
      expect(row.current_state).toBe("pending");
      expect(row.version).toBe(0);
      expect(row.context_json).toBe(JSON.stringify({ status: "new" }));
      expect(row.metadata_json).toBe(JSON.stringify({ orderId: "ORD-1" }));
    });
  });

  describe("findByUuid()", () => {
    it("returns mapped instance when found", async () => {
      const { db } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowInstanceStore(db);

      const result = await store.findByUuid("inst-uuid");

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe("inst-uuid");
      expect(result!.workflowName).toBe("order");
      expect(result!.currentState).toBe("pending");
      expect(result!.version).toBe(0);
      expect(result!.expiresAt).toBeNull();
      expect(result!.context).toEqual({ status: "new" });
      expect(result!.metadata).toEqual({ orderId: "ORD-1" });
    });

    it("returns null when not found", async () => {
      const { db } = createMockDb([]);
      const store = new KyselyWorkflowInstanceStore(db);

      const result = await store.findByUuid("missing");
      expect(result).toBeNull();
    });
  });

  describe("lockByUuid()", () => {
    it("throws when called outside a transaction", async () => {
      const { db } = createMockDb();
      const store = new KyselyWorkflowInstanceStore(db);

      await expect(store.lockByUuid("uuid")).rejects.toThrow("lockByUuid requires an active transaction");
    });

    it("returns instance when found within transaction", async () => {
      const { db, calls } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowInstanceStore(db);
      const trx = db as unknown as Transaction<WorkflowDatabase>;

      const result = await KyselyTransactionContext.run(db, trx, () => store.lockByUuid("inst-uuid"));

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe("inst-uuid");
      expect(calls.some((c) => c.method === "forUpdate")).toBe(true);
    });

    it("returns null when not found within transaction", async () => {
      const { db } = createMockDb([]);
      const store = new KyselyWorkflowInstanceStore(db);
      const trx = db as unknown as Transaction<WorkflowDatabase>;

      const result = await KyselyTransactionContext.run(db, trx, () => store.lockByUuid("missing"));

      expect(result).toBeNull();
    });
  });

  describe("update()", () => {
    it("updates with optimistic locking (version check)", async () => {
      const { db, executeMock, calls } = createMockDb();
      executeMock.mockResolvedValue([{ numUpdatedRows: BigInt(1) }]);
      const store = new KyselyWorkflowInstanceStore(db);

      const updated = { ...sampleInstance, version: 1, currentState: "approved" };
      await store.update(updated);

      // Should have two where clauses: uuid and version
      const whereCalls = calls.filter((c) => c.method === "where");
      expect(whereCalls.length).toBe(2);
      expect(whereCalls[0].args).toEqual(["uuid", "=", "inst-uuid"]);
      expect(whereCalls[1].args).toEqual(["version", "=", 0]); // expectedVersion = 1 - 1
    });

    it("throws WorkflowError on optimistic lock failure", async () => {
      const { db, executeMock } = createMockDb();
      executeMock.mockResolvedValue([{ numUpdatedRows: BigInt(0) }]);
      const store = new KyselyWorkflowInstanceStore(db);

      const updated = { ...sampleInstance, version: 1 };
      await expect(store.update(updated)).rejects.toThrow(WorkflowError);
      await expect(store.update(updated)).rejects.toThrow("Optimistic locking failure");
    });

    it("throws WorkflowError when the update returns an empty result array", async () => {
      // Some dialects/drivers can resolve to [] instead of a row with
      // numUpdatedRows — the `?? BigInt(0)` fallback must treat it as a miss.
      const { db, executeMock } = createMockDb();
      executeMock.mockResolvedValue([]);
      const store = new KyselyWorkflowInstanceStore(db);

      const updated = { ...sampleInstance, version: 1 };
      await expect(store.update(updated)).rejects.toThrow(/Optimistic locking failure/);
    });

    it("does not include metadata_json in the SET payload (metadata is immutable)", async () => {
      const { db, executeMock, calls } = createMockDb();
      executeMock.mockResolvedValue([{ numUpdatedRows: BigInt(1) }]);
      const store = new KyselyWorkflowInstanceStore(db);

      const updated = { ...sampleInstance, version: 1, metadata: { tenant: "bob" } };
      await store.update(updated);

      const setCall = calls.find((c) => c.method === "set");
      expect(setCall).toBeDefined();
      const payload = setCall!.args[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty("metadata_json");
    });
  });

  describe("findExpired()", () => {
    it("throws when called outside a transaction", async () => {
      const { db } = createMockDb();
      const store = new KyselyWorkflowInstanceStore(db);

      await expect(store.findExpired(10, now)).rejects.toThrow("findExpired requires an active transaction");
    });

    it("returns expired instances within transaction", async () => {
      const { db, calls } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowInstanceStore(db);
      const trx = db as unknown as Transaction<WorkflowDatabase>;

      const results = await KyselyTransactionContext.run(db, trx, () => store.findExpired(10, now));

      expect(results).toHaveLength(1);
      expect(results[0].uuid).toBe("inst-uuid");

      expect(calls.some((c) => c.method === "forUpdate")).toBe(true);
      expect(calls.some((c) => c.method === "skipLocked")).toBe(true);
    });
  });
});
