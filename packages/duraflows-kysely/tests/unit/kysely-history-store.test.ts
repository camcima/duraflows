import { describe, it, expect, vi } from "vitest";
import { KyselyWorkflowHistoryStore } from "../../src/kysely-history-store.js";
import { KyselyTransactionContext } from "../../src/kysely-transaction-context.js";
import type { Kysely, Transaction } from "kysely";
import type { WorkflowDatabase } from "../../src/kysely-database.js";
import { WorkflowError, type WorkflowHistoryRecord } from "@duraflows/core";

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

function createMockDb(queryResult: Record<string, unknown>[] = []) {
  const executeMock = vi.fn().mockResolvedValue(queryResult);
  const executeTakeFirstOrThrowMock = vi.fn().mockResolvedValue(queryResult[0]);

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
      "orderBy",
      "limit",
      "offset",
    ];
    for (const method of methods) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      });
    }
    builder.execute = executeMock;
    builder.executeTakeFirstOrThrow = executeTakeFirstOrThrowMock;
    return builder;
  };

  const builder = chainBuilder();
  const db = builder as unknown as Kysely<WorkflowDatabase>;

  return { db, calls, executeMock, executeTakeFirstOrThrowMock };
}

describe("KyselyWorkflowHistoryStore", () => {
  describe("append()", () => {
    it("inserts a history record and returns the generated UUID", async () => {
      const { db, calls, executeTakeFirstOrThrowMock } = createMockDb();
      executeTakeFirstOrThrowMock.mockResolvedValue({ uuid: "new-uuid" });
      const store = new KyselyWorkflowHistoryStore(db);

      const uuid = await store.append(sampleEntry);

      expect(uuid).toBe("new-uuid");

      const valuesCall = calls.find((c) => c.method === "values");
      expect(valuesCall).toBeDefined();
      const row = valuesCall!.args[0] as Record<string, unknown>;
      expect(row.workflow_instance_uuid).toBe("inst-uuid");
      expect(row.outcome).toBe("success");
      expect(row.command_results_json).toBe(JSON.stringify([{ ok: true, code: "DONE" }]));

      const returningCall = calls.find((c) => c.method === "returning");
      expect(returningCall).toBeDefined();
      expect(returningCall!.args[0]).toBe("uuid");
    });

    it("passes null for optional fields when undefined", async () => {
      const { db, calls, executeTakeFirstOrThrowMock } = createMockDb();
      executeTakeFirstOrThrowMock.mockResolvedValue({ uuid: "uuid" });
      const store = new KyselyWorkflowHistoryStore(db);

      const entry: WorkflowHistoryRecord = {
        ...sampleEntry,
        errorMessage: undefined,
        triggerMetadata: undefined,
      };

      await store.append(entry);

      const valuesCall = calls.find((c) => c.method === "values");
      const row = valuesCall!.args[0] as Record<string, unknown>;
      expect(row.error_message).toBeNull();
      expect(row.rejected_by).toBeNull();
      expect(row.trigger_metadata_json).toBe("{}");
    });

    it("inserts rejected_by for guard-rejected outcome", async () => {
      const { db, calls, executeTakeFirstOrThrowMock } = createMockDb();
      executeTakeFirstOrThrowMock.mockResolvedValue({ uuid: "rej-uuid" });
      const store = new KyselyWorkflowHistoryStore(db);

      const uuid = await store.append({
        ...sampleEntry,
        outcome: "guard-rejected",
        rejectedBy: "isVerified",
        commandResultsJson: [],
      });

      expect(uuid).toBe("rej-uuid");
      const valuesCall = calls.find((c) => c.method === "values");
      const row = valuesCall!.args[0] as Record<string, unknown>;
      expect(row.outcome).toBe("guard-rejected");
      expect(row.rejected_by).toBe("isVerified");
    });

    it("uses transaction when available", async () => {
      const { db, executeTakeFirstOrThrowMock } = createMockDb();
      executeTakeFirstOrThrowMock.mockResolvedValue({ uuid: "tx-uuid" });
      const store = new KyselyWorkflowHistoryStore(db);
      const trx = db as unknown as Transaction<WorkflowDatabase>;

      const uuid = await KyselyTransactionContext.run(db, trx, () => store.append(sampleEntry));
      expect(uuid).toBe("tx-uuid");
    });

    it("supplies a WorkflowError factory for the no-row case", async () => {
      const { db, executeTakeFirstOrThrowMock } = createMockDb();
      executeTakeFirstOrThrowMock.mockResolvedValue({ uuid: "uuid" });
      const store = new KyselyWorkflowHistoryStore(db);

      await store.append(sampleEntry);

      const createError = executeTakeFirstOrThrowMock.mock.calls[0][0] as () => Error;
      expect(createError).toBeTypeOf("function");
      const error = createError();
      expect(error).toBeInstanceOf(WorkflowError);
      expect(error.message).toMatch(/RETURNING uuid returned no row/);
    });
  });

  describe("findByInstanceUuid()", () => {
    it("returns mapped records with default pagination", async () => {
      const { db, calls } = createMockDb([sampleRow]);
      const store = new KyselyWorkflowHistoryStore(db);

      const records = await store.findByInstanceUuid("inst-uuid");

      expect(records).toHaveLength(1);
      expect(records[0].workflowInstanceUuid).toBe("inst-uuid");
      expect(records[0].fromState).toBe("pending");
      expect(records[0].eventName).toBe("Approve");
      expect(records[0].outcome).toBe("success");

      const limitCall = calls.find((c) => c.method === "limit");
      expect(limitCall!.args[0]).toBe(50);

      const offsetCall = calls.find((c) => c.method === "offset");
      expect(offsetCall!.args[0]).toBe(0);
    });

    it("uses custom limit and offset", async () => {
      const { db, calls } = createMockDb([]);
      const store = new KyselyWorkflowHistoryStore(db);

      await store.findByInstanceUuid("id", { limit: 10, offset: 20 });

      const limitCall = calls.find((c) => c.method === "limit");
      expect(limitCall!.args[0]).toBe(10);

      const offsetCall = calls.find((c) => c.method === "offset");
      expect(offsetCall!.args[0]).toBe(20);
    });

    it("returns empty array when no records found", async () => {
      const { db } = createMockDb([]);
      const store = new KyselyWorkflowHistoryStore(db);

      const records = await store.findByInstanceUuid("unknown");
      expect(records).toEqual([]);
    });

    it("maps rejected_by from a guard-rejected row", async () => {
      const { db } = createMockDb([
        { ...sampleRow, outcome: "guard-rejected", rejected_by: "isVerified", command_results_json: [] },
      ]);
      const store = new KyselyWorkflowHistoryStore(db);

      const records = await store.findByInstanceUuid("inst-uuid");
      expect(records).toHaveLength(1);
      expect(records[0].outcome).toBe("guard-rejected");
      expect(records[0].rejectedBy).toBe("isVerified");
    });

    it("maps rejected_by as undefined when row.rejected_by is null", async () => {
      const { db } = createMockDb([{ ...sampleRow, rejected_by: null }]);
      const store = new KyselyWorkflowHistoryStore(db);

      const records = await store.findByInstanceUuid("inst-uuid");
      expect(records[0].rejectedBy).toBeUndefined();
    });
  });
});
