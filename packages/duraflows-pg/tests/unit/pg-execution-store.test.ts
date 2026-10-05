import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  PgWorkflowExecutionStore,
  PgTransactionContext,
  pgWorkflowProviders,
  generateMigrationSql,
  generateDurableExecutionMigrationSql,
} from "../../src/index.js";
import type { DurableWorkflowExecution } from "@duraflows/core";

const e = {
  uuid: "execution",
  workflowInstanceUuid: "instance",
  idempotencyKey: "key",
  status: "pending",
  revision: 1,
  availableAt: "2026-10-04T00:00:00Z",
  leaseUntil: null,
} as DurableWorkflowExecution;
describe("PgWorkflowExecutionStore", () => {
  it("routes reads through the pool or ambient transaction, requires transactional writes, and fences revisions", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ execution_json: e }], rowCount: 1 });
    const pool = { query } as unknown as Pool;
    const store = new PgWorkflowExecutionStore(pool);
    await expect(store.create(e)).rejects.toThrow("active transaction");
    await expect(store.update(e)).rejects.toThrow("active transaction");
    expect(await store.findByUuid("execution")).toEqual(e);
    query.mockResolvedValueOnce({ rows: [] });
    expect(await store.findByUuid("missing")).toBeNull();
    expect(await store.findByKey("instance", "key")).toEqual(e);
    expect(await store.findActive("instance")).toEqual(e);
    expect(await store.findDue(2, new Date())).toEqual([e]);
    const transactionQuery = vi.fn().mockResolvedValue({ rows: [{ execution_json: e }], rowCount: 1 });
    await PgTransactionContext.run(pool, { query: transactionQuery } as unknown as PoolClient, async () => {
      await store.create(e);
      expect(transactionQuery.mock.calls[0][1]).toEqual([
        e.uuid,
        e.workflowInstanceUuid,
        e.idempotencyKey,
        e.status,
        e.availableAt,
        null,
        1,
        JSON.stringify(e),
      ]);
      await store.update(e);
      expect(transactionQuery.mock.calls[1][1].at(-1)).toBe(0);
      expect(await store.findByUuid(e.uuid)).toEqual(e);
      transactionQuery.mockResolvedValueOnce({ rowCount: 0 });
      await expect(store.update(e)).rejects.toThrow("revision conflict");
    });
    expect(pgWorkflowProviders(pool).executionStore).toBeUndefined();
    expect(pgWorkflowProviders(pool, { durableExecution: true }).executionStore).toBeInstanceOf(
      PgWorkflowExecutionStore,
    );
  });
  it("counts definition usage on the ambient connection", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: "2" }] });
    const pool = { query } as unknown as Pool;
    const store = new PgWorkflowExecutionStore(pool);
    const options = { workflowName: "order", definitionVersion: 2, excludeStates: ["done"] };
    expect(await store.countInstancesUsingDefinition(options)).toBe(2);
    expect(query.mock.calls[0][1]).toEqual(["order", 2, ["done"]]);
    const transactionQuery = vi.fn().mockResolvedValue({ rows: [{ count: "0" }] });
    await PgTransactionContext.run(pool, { query: transactionQuery } as unknown as PoolClient, async () => {
      expect(await store.countInstancesUsingDefinition({ ...options, excludeStates: [] })).toBe(0);
    });
    expect(transactionQuery).toHaveBeenCalledOnce();
  });
  it("keeps the table opt-in and supplies standalone upgrade and rollback SQL", () => {
    expect(generateMigrationSql().up).not.toContain("workflow_executions");
    const migration = generateDurableExecutionMigrationSql();
    expect(migration.up).toContain("CREATE TABLE workflow_executions");
    expect(migration.up).toContain('COLLATE "C"');
    expect(generateMigrationSql({ includeDurableExecution: true }).up).toContain(migration.up);
    expect(generateMigrationSql({ includeDurableExecution: true }).down).toContain(migration.down);
  });
});
