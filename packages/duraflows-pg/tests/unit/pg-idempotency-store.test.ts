import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgWorkflowIdempotencyStore, PgTransactionContext, pgWorkflowProviders } from "../../src/index.js";
import type { WorkflowExecutionResult } from "@duraflows/core";

const result: WorkflowExecutionResult = {
  outcome: "success",
  fromState: "new",
  toState: "done",
  commandResults: [],
  historyUuid: "history",
};
const row = {
  workflow_instance_uuid: "instance",
  idempotency_key: "key",
  event_name: "Submit",
  fingerprint: null,
  result_json: result,
  created_at: "2026-10-03T00:00:00Z",
};

describe("PgWorkflowIdempotencyStore", () => {
  it("requires the matching pool's active transaction for all methods", async () => {
    const pool = {} as Pool;
    const store = new PgWorkflowIdempotencyStore(pool);
    await expect(store.find("instance", "key")).rejects.toThrow("active transaction");
    await expect(
      store.reserve({ workflowInstanceUuid: "instance", key: "key", eventName: "Submit" }),
    ).rejects.toThrow();
    await expect(store.complete("instance", "key", result)).rejects.toThrow();
    await PgTransactionContext.run({} as Pool, {} as PoolClient, async () => {
      await expect(store.find("instance", "key")).rejects.toThrow("active transaction");
    });
  });

  it("uses the transaction connection for lookup, reservation, and completion", async () => {
    const pool = { query: vi.fn() } as unknown as Pool;
    const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
    const client = { query } as unknown as PoolClient;
    const store = new PgWorkflowIdempotencyStore(pool);
    await PgTransactionContext.run(pool, client, async () => {
      expect(await store.find("instance", "key")).toMatchObject({
        key: "key",
        result,
        fingerprint: undefined,
        createdAt: new Date(row.created_at),
      });
      query.mockResolvedValueOnce({ rows: [{ ...row, fingerprint: "input", result_json: null }] });
      expect(await store.find("instance", "key")).toMatchObject({ fingerprint: "input", result: null });
      query.mockResolvedValueOnce({ rows: [] });
      expect(await store.find("instance", "missing")).toBeNull();
      await store.reserve({ workflowInstanceUuid: "instance", key: "key", eventName: "Submit" });
      expect(query.mock.calls.at(-1)![1]).toEqual(["instance", "key", "Submit", null]);
      await store.reserve({ workflowInstanceUuid: "instance", key: "key", eventName: "Submit", fingerprint: "input" });
      expect(query.mock.calls.at(-1)![1]).toEqual(["instance", "key", "Submit", "input"]);
      await store.complete("instance", "key", result);
      expect(query.mock.calls.at(-1)![1]).toEqual(["instance", "key", JSON.stringify(result)]);
      query.mockResolvedValueOnce({ rowCount: 0 });
      await expect(store.complete("instance", "key", result)).rejects.toThrow("missing or already completed");
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("keeps factory defaults and enables the capability explicitly", () => {
    const pool = {} as Pool;
    expect(pgWorkflowProviders(pool).idempotencyStore).toBeUndefined();
    expect(pgWorkflowProviders(pool, { idempotency: true }).idempotencyStore).toBeInstanceOf(
      PgWorkflowIdempotencyStore,
    );
  });
});
