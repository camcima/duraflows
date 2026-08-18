import { describe, it, expect, vi } from "vitest";
import { PgWorkflowDefinitionStore } from "../../src/pg-definition-store.js";
import { PgTransactionContext } from "../../src/pg-transaction-context.js";
import { WorkflowError } from "@duraflows/core";
import type { Pool, PoolClient } from "pg";
import type { WorkflowDefinition } from "@duraflows/core";

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

const definitionJson: WorkflowDefinition = {
  name: "order",
  version: 1,
  initialState: "start",
  states: {
    start: { events: { Go: { targetState: "done" } } },
    done: {},
  },
};

const registeredAt = new Date("2026-01-15T12:00:00.000Z");

const sampleRecord = {
  workflowName: "order",
  version: 1,
  contentHash: `sha256:${"ab".repeat(32)}`,
  definitionJson,
};

const sampleRow = {
  workflow_name: "order",
  version: 1,
  content_hash: `sha256:${"ab".repeat(32)}`,
  definition_json: definitionJson,
  registered_at: registeredAt.toISOString(),
};

describe("PgWorkflowDefinitionStore", () => {
  describe("ensure()", () => {
    it("inserts a new definition (ON CONFLICT DO NOTHING) and returns the re-selected row", async () => {
      const pool = createMockPool();
      const queryMock = pool.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [sampleRow] });
      const store = new PgWorkflowDefinitionStore(pool);

      const result = await store.ensure(sampleRecord);

      expect(queryMock).toHaveBeenCalledTimes(2);
      const [insertSql, insertParams] = queryMock.mock.calls[0];
      expect(insertSql).toContain("INSERT INTO workflow_definitions");
      expect(insertSql).toContain("ON CONFLICT (workflow_name, version) DO NOTHING");
      expect(insertParams[0]).toBe("order");
      expect(insertParams[1]).toBe(1);
      expect(insertParams[2]).toBe(`sha256:${"ab".repeat(32)}`);
      expect(insertParams[3]).toBe(JSON.stringify(definitionJson));

      const [selectSql, selectParams] = queryMock.mock.calls[1];
      expect(selectSql).toContain("SELECT * FROM workflow_definitions WHERE workflow_name = $1 AND version = $2");
      expect(selectParams).toEqual(["order", 1]);

      expect(result.workflowName).toBe("order");
      expect(result.version).toBe(1);
      expect(result.registeredAt).toBeInstanceOf(Date);
    });

    it("returns the pre-existing row unchanged when (name, version) already exists", async () => {
      const pool = createMockPool();
      const queryMock = pool.query as ReturnType<typeof vi.fn>;
      // The INSERT is a no-op because the row already exists; the re-select
      // finds the pre-existing row, not whatever was passed to ensure().
      queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [sampleRow] });
      const store = new PgWorkflowDefinitionStore(pool);

      const result = await store.ensure({ ...sampleRecord, contentHash: `sha256:${"cd".repeat(32)}` });

      expect(result.contentHash).toBe(`sha256:${"ab".repeat(32)}`);
    });

    it("throws WorkflowError when the post-insert re-select finds nothing", async () => {
      const pool = createMockPool();
      const queryMock = pool.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const store = new PgWorkflowDefinitionStore(pool);

      await expect(store.ensure(sampleRecord)).rejects.toThrow(WorkflowError);

      queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      await expect(store.ensure(sampleRecord)).rejects.toThrow(
        'Failed to ensure workflow definition "order" version 1',
      );
    });

    it("uses the transaction client when an active transaction is present", async () => {
      const pool = createMockPool();
      const txClient = createMockClient();
      const txQueryMock = txClient.query as ReturnType<typeof vi.fn>;
      txQueryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [sampleRow] });
      const store = new PgWorkflowDefinitionStore(pool);

      const result = await PgTransactionContext.run(pool, txClient, () => store.ensure(sampleRecord));

      expect(result.workflowName).toBe("order");
      expect(txQueryMock).toHaveBeenCalledTimes(2);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe("findByNameAndVersion()", () => {
    it("returns the mapped definition when found", async () => {
      const pool = createMockPool({ rows: [sampleRow], rowCount: 1 });
      const store = new PgWorkflowDefinitionStore(pool);

      const result = await store.findByNameAndVersion("order", 1);

      expect(result).not.toBeNull();
      expect(result!.workflowName).toBe("order");
      expect(result!.version).toBe(1);
      expect(result!.contentHash).toBe(`sha256:${"ab".repeat(32)}`);
      expect(result!.definitionJson).toEqual(definitionJson);
      expect(result!.registeredAt).toBeInstanceOf(Date);
      expect(result!.registeredAt.toISOString()).toBe(registeredAt.toISOString());

      const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sql).toContain("SELECT * FROM workflow_definitions WHERE workflow_name = $1 AND version = $2");
      expect(params).toEqual(["order", 1]);
    });

    it("returns null when not found", async () => {
      const pool = createMockPool({ rows: [], rowCount: 0 });
      const store = new PgWorkflowDefinitionStore(pool);

      const result = await store.findByNameAndVersion("order", 99);
      expect(result).toBeNull();
    });

    it("falls back to the pool when no active transaction is present", async () => {
      const pool = createMockPool({ rows: [sampleRow], rowCount: 1 });
      const store = new PgWorkflowDefinitionStore(pool);

      await store.findByNameAndVersion("order", 1);

      expect(pool.query).toHaveBeenCalledOnce();
    });

    it("uses the transaction client when an active transaction is present", async () => {
      const pool = createMockPool();
      const txClient = createMockClient({ rows: [sampleRow], rowCount: 1 });
      const store = new PgWorkflowDefinitionStore(pool);

      const result = await PgTransactionContext.run(pool, txClient, () => store.findByNameAndVersion("order", 1));

      expect(result).not.toBeNull();
      expect(txClient.query).toHaveBeenCalledOnce();
      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});
