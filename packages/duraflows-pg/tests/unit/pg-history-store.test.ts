import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgWorkflowHistoryStore } from "../../src/pg-history-store.js";
import { PgTransactionContext } from "../../src/pg-transaction-context.js";
import type { Pool, PoolClient } from "pg";
import type { WorkflowHistoryRecord } from "@duraflows/core";

function createMockPool(queryResult = { rows: [] as Record<string, unknown>[] }) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as Pool;
}

function createMockClient(queryResult = { rows: [] as Record<string, unknown>[] }) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
    release: vi.fn(),
  } as unknown as PoolClient;
}

const sampleEntry: WorkflowHistoryRecord = {
  workflowInstanceUuid: "inst-uuid",
  fromState: "pending",
  eventName: "Approve",
  toState: "approved",
  outcome: "success",
  errorMessage: undefined,
  commandResultsJson: [{ ok: true, code: "DONE" }],
  triggerMetadata: { source: "user", actor: "actor-uuid" },
};

const sampleRow = {
  uuid: "history-uuid",
  workflow_instance_uuid: "inst-uuid",
  from_state: "pending",
  event_name: "Approve",
  to_state: "approved",
  outcome: "success",
  error_message: null,
  command_results_json: [{ ok: true, code: "DONE" }],
  trigger_metadata_json: { source: "user", actor: "actor-uuid" },
};

describe("PgWorkflowHistoryStore", () => {
  describe("append()", () => {
    it("inserts a history record and returns the generated UUID", async () => {
      const pool = createMockPool({ rows: [{ uuid: "new-uuid" }] });
      const store = new PgWorkflowHistoryStore(pool);

      const uuid = await store.append(sampleEntry);

      expect(uuid).toBe("new-uuid");
      expect(pool.query).toHaveBeenCalledOnce();
      const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("INSERT INTO workflow_history");
      expect(params[0]).toBe("inst-uuid");
      expect(params[4]).toBe("success");
      // commandResultsJson should be JSON-stringified
      expect(params[6]).toBe(JSON.stringify([{ ok: true, code: "DONE" }]));
    });

    it("passes null for optional fields when undefined", async () => {
      const pool = createMockPool({ rows: [{ uuid: "uuid" }] });
      const store = new PgWorkflowHistoryStore(pool);

      const entry: WorkflowHistoryRecord = {
        ...sampleEntry,
        errorMessage: undefined,
        triggerMetadata: undefined,
      };

      await store.append(entry);
      const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(params[5]).toBeNull(); // errorMessage
      expect(params[7]).toBe("{}"); // triggerMetadata defaults to empty object
    });

    it("uses transaction client when available", async () => {
      const pool = createMockPool();
      const txClient = createMockClient({ rows: [{ uuid: "tx-uuid" }] });
      const store = new PgWorkflowHistoryStore(pool);

      const uuid = await PgTransactionContext.run(txClient, () => store.append(sampleEntry));

      expect(uuid).toBe("tx-uuid");
      expect(txClient.query).toHaveBeenCalledOnce();
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe("findByInstanceUuid()", () => {
    it("returns mapped records with default pagination", async () => {
      const pool = createMockPool({ rows: [sampleRow] });
      const store = new PgWorkflowHistoryStore(pool);

      const records = await store.findByInstanceUuid("inst-uuid");

      expect(records).toHaveLength(1);
      expect(records[0].workflowInstanceUuid).toBe("inst-uuid");
      expect(records[0].fromState).toBe("pending");
      expect(records[0].eventName).toBe("Approve");
      expect(records[0].outcome).toBe("success");

      const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(params[1]).toBe(50); // default limit
      expect(params[2]).toBe(0); // default offset
    });

    it("uses custom limit and offset", async () => {
      const pool = createMockPool({ rows: [] });
      const store = new PgWorkflowHistoryStore(pool);

      await store.findByInstanceUuid("id", { limit: 10, offset: 20 });

      const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(params[1]).toBe(10);
      expect(params[2]).toBe(20);
    });

    it("returns empty array when no records found", async () => {
      const pool = createMockPool({ rows: [] });
      const store = new PgWorkflowHistoryStore(pool);

      const records = await store.findByInstanceUuid("unknown");
      expect(records).toEqual([]);
    });
  });
});
