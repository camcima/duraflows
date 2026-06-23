import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
  // `options` sets the backend `search_path` as a startup parameter, applied at
  // connection establishment for EVERY pooled connection before any query runs.
  // This isolates the suite's tables in a dedicated, throwaway schema so a
  // DATABASE_URL accidentally pointed at a shared database can never DROP or
  // TRUNCATE real tables in `public`. The path is duraflows_pg_it ONLY (no `public`) so
  // the unqualified DDL/DML here stays inside the throwaway schema; built-ins
  // like gen_random_uuid() resolve from pg_catalog regardless.
  const pool = new Pool({ connectionString: databaseUrl, options: "-c search_path=duraflows_pg_it" });
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
    // Bootstrap the dedicated schema on a single client. CREATE SCHEMA is
    // explicit (creates duraflows_pg_it regardless of search_path); every
    // subsequent unqualified statement resolves into it via the pool's startup
    // option. The name avoids the reserved pg_* prefix Postgres rejects.
    const client = await pool.connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS duraflows_pg_it");
      await client.query("DROP TABLE IF EXISTS workflow_history, workflow_instances CASCADE");
      const { up } = generateMigrationSql();
      await client.query(up);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS duraflows_pg_it CASCADE");
    } finally {
      client.release();
    }
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
    // Cleanup runs in afterEach (not at the end of each test body) so a
    // failing assertion cannot leak rows into the next test.
    afterEach(async () => {
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
    });

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
    });
  });
}
