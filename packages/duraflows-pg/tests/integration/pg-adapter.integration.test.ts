import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runInstanceStoreConformance } from "@duraflows/core/testing";
import type { WorkflowInstance, WorkflowHistoryRecord } from "@duraflows/core";
import {
  PgWorkflowInstanceStore,
  PgWorkflowHistoryStore,
  PgTransactionRunner,
  generateMigrationSql,
} from "@duraflows/pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  describe.skip("pg adapter integration (set DATABASE_URL to run)", () => {
    it.skip("skipped", () => {});
  });
} else {
  const pool = new Pool({ connectionString: databaseUrl });
  const transactionRunner = new PgTransactionRunner(pool);
  const instanceStore = new PgWorkflowInstanceStore(pool);
  const historyStore = new PgWorkflowHistoryStore(pool);

  const makeInstance = (overrides?: Partial<WorkflowInstance>): WorkflowInstance => ({
    uuid: randomUUID(),
    workflowName: "integration-test",
    currentState: "initial",
    version: 0,
    expiresAt: null,
    lastTransitionAt: new Date("2026-01-01T00:00:00Z"),
    context: {},
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });

  beforeAll(async () => {
    await pool.query("DROP TABLE IF EXISTS workflow_history, workflow_instances CASCADE");
    const { up } = generateMigrationSql();
    await pool.query(up);
  });

  afterAll(async () => {
    await pool.end();
  });

  runInstanceStoreConformance("pg (real PostgreSQL)", {
    setup: async () => ({
      store: instanceStore,
      transactionRunner,
      teardown: async () => {
        await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      },
    }),
  });

  describe("pg adapter integration", () => {
    it("findExpired executes against a real database and claims only expired rows", async () => {
      const expired = makeInstance({ expiresAt: new Date("2020-01-01T00:00:00Z") });
      const future = makeInstance({ expiresAt: new Date("2099-01-01T00:00:00Z") });
      const noTimeout = makeInstance();
      await transactionRunner.runInTransaction(async () => {
        await instanceStore.create(expired);
        await instanceStore.create(future);
        await instanceStore.create(noTimeout);
      });

      const found = await transactionRunner.runInTransaction(() => instanceStore.findExpired(10, new Date()));

      expect(found.map((i) => i.uuid)).toEqual([expired.uuid]);
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
    });

    it("update with a stale version throws (optimistic locking against real WHERE clause)", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));

      instance.version = 1; // runtime convention: version is pre-incremented before update()
      await transactionRunner.runInTransaction(() => instanceStore.update(instance));

      // Re-issuing the same version (stale write) must not match any row.
      await expect(transactionRunner.runInTransaction(() => instanceStore.update(instance))).rejects.toThrow(
        /Optimistic locking failure/,
      );
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
    });

    it("history round-trips guard-rejected outcome with rejected_by, and maps NULL to undefined", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));

      const rejected: WorkflowHistoryRecord = {
        workflowInstanceUuid: instance.uuid,
        fromState: "initial",
        eventName: "submit",
        toState: "initial",
        outcome: "guard-rejected",
        rejectedBy: "can-submit",
        commandResultsJson: [],
      };
      const success: WorkflowHistoryRecord = {
        workflowInstanceUuid: instance.uuid,
        fromState: "initial",
        eventName: "submit",
        toState: "submitted",
        outcome: "success",
        commandResultsJson: [{ ok: true, code: "DONE" }],
      };
      await transactionRunner.runInTransaction(async () => {
        await historyStore.append(rejected);
        await historyStore.append(success);
      });

      const records = await historyStore.findByInstanceUuid(instance.uuid);
      expect(records).toHaveLength(2);
      const guardRow = records.find((r) => r.outcome === "guard-rejected")!;
      expect(guardRow.rejectedBy).toBe("can-submit");
      expect(guardRow.errorMessage).toBeUndefined(); // NULL must map to undefined, not null
      const successRow = records.find((r) => r.outcome === "success")!;
      expect(successRow.rejectedBy).toBeUndefined();
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
    });
  });
}
