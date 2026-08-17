import { describe, it, expect, vi } from "vitest";
import { PgWorkflowInstanceStore } from "../../src/pg-instance-store.js";
import { PgTransactionContext } from "../../src/pg-transaction-context.js";
import { WorkflowError } from "@duraflows/core";
import type { Pool, PoolClient } from "pg";
import type { WorkflowInstance } from "@duraflows/core";

function createMockPool(queryResult = { rows: [] as Record<string, unknown>[], rowCount: 0 }) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as Pool;
}

function createMockClient(queryResult = { rows: [] as Record<string, unknown>[], rowCount: 0 }) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
    release: vi.fn(),
  } as unknown as PoolClient;
}

const now = new Date("2026-01-15T12:00:00.000Z");

const sampleInstance: WorkflowInstance = {
  uuid: "inst-uuid",
  workflowName: "order",
  currentState: "pending",
  version: 0,
  definitionVersion: null,
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
  last_transition_at: now.toISOString(),
  context_json: { status: "new" },
  metadata_json: { orderId: "ORD-1" },
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
};

describe("PgWorkflowInstanceStore", () => {
  describe("create()", () => {
    it("inserts an instance with correct parameters", async () => {
      const pool = createMockPool();
      const store = new PgWorkflowInstanceStore(pool);

      await store.create(sampleInstance);

      expect(pool.query).toHaveBeenCalledOnce();
      const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("INSERT INTO workflow_instances");
      expect(params[0]).toBe("inst-uuid");
      expect(params[1]).toBe("order");
      expect(params[2]).toBe("pending");
      expect(params[6]).toBe(JSON.stringify({ status: "new" }));
      expect(params[7]).toBe(JSON.stringify({ orderId: "ORD-1" }));
    });
  });

  describe("findByUuid()", () => {
    it("returns mapped instance when found", async () => {
      const pool = createMockPool({ rows: [sampleRow], rowCount: 1 });
      const store = new PgWorkflowInstanceStore(pool);

      const result = await store.findByUuid("inst-uuid");

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe("inst-uuid");
      expect(result!.workflowName).toBe("order");
      expect(result!.currentState).toBe("pending");
      expect(result!.version).toBe(0);
      expect(result!.expiresAt).toBeNull();
      expect(result!.context).toEqual({ status: "new" });
      expect(result!.metadata).toEqual({ orderId: "ORD-1" });
      expect(result!.createdAt).toBeInstanceOf(Date);
    });

    it("returns null when not found", async () => {
      const pool = createMockPool({ rows: [], rowCount: 0 });
      const store = new PgWorkflowInstanceStore(pool);

      const result = await store.findByUuid("missing");
      expect(result).toBeNull();
    });

    it("maps non-null expiresAt correctly", async () => {
      const expiresAt = "2026-02-01T00:00:00.000Z";
      const pool = createMockPool({
        rows: [{ ...sampleRow, expires_at: expiresAt }],
        rowCount: 1,
      });
      const store = new PgWorkflowInstanceStore(pool);

      const result = await store.findByUuid("inst-uuid");
      expect(result!.expiresAt).toBeInstanceOf(Date);
      expect(result!.expiresAt!.toISOString()).toBe(expiresAt);
    });
  });

  describe("lockByUuid()", () => {
    it("throws when called outside a transaction", async () => {
      const pool = createMockPool();
      const store = new PgWorkflowInstanceStore(pool);

      // WorkflowExceptionFilter is @Catch(WorkflowError), so a bare Error here
      // bypasses it entirely and surfaces as an unmapped 500 with no logging.
      await expect(store.lockByUuid("uuid")).rejects.toThrow(WorkflowError);
      await expect(store.lockByUuid("uuid")).rejects.toThrow("lockByUuid requires an active transaction");
    });

    it("returns instance when found within transaction", async () => {
      const pool = createMockPool();
      const txClient = createMockClient({ rows: [sampleRow], rowCount: 1 });
      const store = new PgWorkflowInstanceStore(pool);

      const result = await PgTransactionContext.run(pool, txClient, () => store.lockByUuid("inst-uuid"));

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe("inst-uuid");
      const sql = (txClient.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sql).toContain("FOR UPDATE");
    });

    it("returns null when not found within transaction", async () => {
      const pool = createMockPool();
      const txClient = createMockClient({ rows: [], rowCount: 0 });
      const store = new PgWorkflowInstanceStore(pool);

      const result = await PgTransactionContext.run(pool, txClient, () => store.lockByUuid("missing"));

      expect(result).toBeNull();
    });
  });

  describe("update()", () => {
    it("updates with optimistic locking (version check)", async () => {
      const pool = createMockPool({ rows: [], rowCount: 1 }); // 1 row affected
      const store = new PgWorkflowInstanceStore(pool);

      const updated = { ...sampleInstance, version: 1, currentState: "approved" };
      await store.update(updated);

      const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("UPDATE workflow_instances");
      expect(sql).toContain("AND version = $8");
      expect(params[7]).toBe(0); // expectedVersion = version - 1
    });

    it("throws WorkflowError on optimistic lock failure", async () => {
      const pool = createMockPool({ rows: [], rowCount: 0 }); // 0 rows affected
      const store = new PgWorkflowInstanceStore(pool);

      const updated = { ...sampleInstance, version: 1 };
      await expect(store.update(updated)).rejects.toThrow(WorkflowError);
      await expect(store.update(updated)).rejects.toThrow("Optimistic locking failure");
    });

    it("does not include metadata_json in UPDATE statement (metadata is immutable)", async () => {
      const pool = createMockPool({ rows: [], rowCount: 1 });
      const store = new PgWorkflowInstanceStore(pool);

      const updated = { ...sampleInstance, version: 1, metadata: { tenant: "bob" } };
      await store.update(updated);

      const [sql] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).not.toContain("metadata_json");
    });
  });

  describe("findExpired()", () => {
    it("throws when called outside a transaction", async () => {
      const pool = createMockPool();
      const store = new PgWorkflowInstanceStore(pool);

      await expect(store.findExpired(10, now)).rejects.toThrow(WorkflowError);
      await expect(store.findExpired(10, now)).rejects.toThrow("findExpired requires an active transaction");
    });

    it("returns expired instances within transaction", async () => {
      const pool = createMockPool();
      const txClient = createMockClient({ rows: [sampleRow], rowCount: 1 });
      const store = new PgWorkflowInstanceStore(pool);

      const results = await PgTransactionContext.run(pool, txClient, () => store.findExpired(10, now));

      expect(results).toHaveLength(1);
      expect(results[0].uuid).toBe("inst-uuid");

      const sql = (txClient.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(sql).toContain("LIMIT $1");
    });
  });
});
