import { describe, it, expect, vi } from "vitest";
import { KyselyWorkflowDefinitionStore } from "../../src/kysely-definition-store.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import { WorkflowError } from "@duraflows/core";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowDatabase } from "../../src/kysely-database.js";
import type { WorkflowDefinition } from "@duraflows/core";

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
  registered_at: registeredAt,
};

// Creates a mock Kysely db that tracks method calls on the builder chain,
// including the nested `onConflict((oc) => oc.columns(...).doNothing())`
// callback that `insertInto(...).onConflict(...)` invokes.
function createMockDb(queryResult: Record<string, unknown>[] = []) {
  const executeMock = vi.fn().mockResolvedValue(undefined);
  const executeTakeFirstMock = vi.fn().mockResolvedValue(queryResult[0] ?? undefined);

  const calls: { method: string; args: unknown[] }[] = [];

  const chainBuilder = (): Record<string, unknown> => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    const methods = ["insertInto", "values", "selectFrom", "selectAll", "where"];
    for (const method of methods) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      });
    }
    builder.onConflict = vi.fn((onConflictCallback: (oc: Record<string, unknown>) => unknown) => {
      calls.push({ method: "onConflict", args: [] });
      const ocBuilder: Record<string, ReturnType<typeof vi.fn>> = {};
      ocBuilder.columns = vi.fn((...args: unknown[]) => {
        calls.push({ method: "onConflict.columns", args });
        return ocBuilder;
      });
      ocBuilder.doNothing = vi.fn((...args: unknown[]) => {
        calls.push({ method: "onConflict.doNothing", args });
        return ocBuilder;
      });
      onConflictCallback(ocBuilder);
      return builder;
    });
    builder.execute = executeMock;
    builder.executeTakeFirst = executeTakeFirstMock;
    return builder;
  };

  const builder = chainBuilder();
  const db = builder as unknown as Kysely<WorkflowDatabase>;

  return { db, calls, executeMock, executeTakeFirstMock };
}

describe("KyselyWorkflowDefinitionStore", () => {
  describe("ensure()", () => {
    it("inserts a new definition with the insert-if-absent onConflict chain and returns the re-selected row", async () => {
      const { db, calls, executeTakeFirstMock } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowDefinitionStore(db);

      const result = await store.ensure(sampleRecord);

      const insertCall = calls.find((c) => c.method === "insertInto");
      expect(insertCall).toBeDefined();
      expect(insertCall!.args[0]).toBe("workflow_definitions");

      const valuesCall = calls.find((c) => c.method === "values");
      expect(valuesCall).toBeDefined();
      const row = valuesCall!.args[0] as Record<string, unknown>;
      expect(row.workflow_name).toBe("order");
      expect(row.version).toBe(1);
      expect(row.content_hash).toBe(`sha256:${"ab".repeat(32)}`);
      expect(row.definition_json).toBe(JSON.stringify(definitionJson));

      const columnsCall = calls.find((c) => c.method === "onConflict.columns");
      expect(columnsCall).toBeDefined();
      expect(columnsCall!.args[0]).toEqual(["workflow_name", "version"]);
      expect(calls.some((c) => c.method === "onConflict.doNothing")).toBe(true);

      expect(executeTakeFirstMock).toHaveBeenCalledOnce();
      expect(result.workflowName).toBe("order");
      expect(result.version).toBe(1);
      expect(result.registeredAt).toBeInstanceOf(Date);
    });

    it("returns the pre-existing row unchanged when (name, version) already exists", async () => {
      // The INSERT is a no-op because the row already exists; the re-select
      // finds the pre-existing row, not whatever was passed to ensure().
      const { db } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowDefinitionStore(db);

      const result = await store.ensure({ ...sampleRecord, contentHash: `sha256:${"cd".repeat(32)}` });

      expect(result.contentHash).toBe(`sha256:${"ab".repeat(32)}`);
    });

    it("throws WorkflowError when the post-insert re-select finds nothing", async () => {
      const { db } = createMockDb([]);
      const store = new KyselyWorkflowDefinitionStore(db);

      await expect(store.ensure(sampleRecord)).rejects.toThrow(WorkflowError);
      await expect(store.ensure(sampleRecord)).rejects.toThrow(
        'Failed to ensure workflow definition "order" version 1',
      );
    });

    it("uses the transaction when an active transaction is present", async () => {
      const { db } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowDefinitionStore(db);
      const trx = db as unknown as Transaction<WorkflowDatabase>;

      const result = await KyselyTransactionContext.run(db, trx, () => store.ensure(sampleRecord));

      expect(result.workflowName).toBe("order");
    });
  });

  describe("findByNameAndVersion()", () => {
    it("returns the mapped definition when found", async () => {
      const { db, calls } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowDefinitionStore(db);

      const result = await store.findByNameAndVersion("order", 1);

      expect(result).not.toBeNull();
      expect(result!.workflowName).toBe("order");
      expect(result!.version).toBe(1);
      expect(result!.contentHash).toBe(`sha256:${"ab".repeat(32)}`);
      expect(result!.definitionJson).toEqual(definitionJson);
      expect(result!.registeredAt).toBeInstanceOf(Date);
      expect(result!.registeredAt).toEqual(registeredAt);

      const selectCall = calls.find((c) => c.method === "selectFrom");
      expect(selectCall!.args[0]).toBe("workflow_definitions");

      const whereCalls = calls.filter((c) => c.method === "where");
      expect(whereCalls.length).toBe(2);
      expect(whereCalls[0].args).toEqual(["workflow_name", "=", "order"]);
      expect(whereCalls[1].args).toEqual(["version", "=", 1]);
    });

    it("returns null when not found", async () => {
      const { db } = createMockDb([]);
      const store = new KyselyWorkflowDefinitionStore(db);

      const result = await store.findByNameAndVersion("order", 99);
      expect(result).toBeNull();
    });

    it("falls back to the db when no active transaction is present", async () => {
      const { db, executeTakeFirstMock } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowDefinitionStore(db);

      const result = await store.findByNameAndVersion("order", 1);

      expect(result).not.toBeNull();
      expect(executeTakeFirstMock).toHaveBeenCalledOnce();
    });

    it("uses the transaction when an active transaction is present", async () => {
      const { db } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowDefinitionStore(db);
      const trx = db as unknown as Transaction<WorkflowDatabase>;

      const result = await KyselyTransactionContext.run(db, trx, () => store.findByNameAndVersion("order", 1));

      expect(result).not.toBeNull();
      expect(result!.workflowName).toBe("order");
    });
  });
});
