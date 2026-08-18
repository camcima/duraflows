import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runInstanceStoreConformance, runDefinitionStoreConformance } from "@duraflows/core/testing";
import type { WorkflowInstance, WorkflowHistoryRecord } from "@duraflows/core";
import {
  PgWorkflowInstanceStore,
  PgWorkflowHistoryStore,
  PgTransactionRunner,
  PgTransactionContext,
  generateMigrationSql,
} from "@duraflows/pg";
import { PgWorkflowDefinitionStore } from "../../src/pg-definition-store.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl && process.env.REQUIRE_INTEGRATION_DB === "1") {
  // CI sets REQUIRE_INTEGRATION_DB=1. There, a missing DATABASE_URL means the
  // service container or the secret broke — and silently skipping every
  // real-SQL test would hand back a green badge with zero integration
  // coverage. Fail loudly instead. Locally the flag is unset, so a developer
  // without a database still gets the skip below.
  describe("pg adapter integration", () => {
    it("fails because REQUIRE_INTEGRATION_DB is set but DATABASE_URL is not", () => {
      throw new Error(
        "REQUIRE_INTEGRATION_DB=1 but DATABASE_URL is not set: the integration database is unavailable, " +
          "so the pg adapter integration suite cannot run.",
      );
    });
  });
} else if (!databaseUrl) {
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
  const definitionStore = new PgWorkflowDefinitionStore(pool);

  const makeInstance = (overrides?: Partial<WorkflowInstance>): WorkflowInstance => ({
    uuid: randomUUID(),
    workflowName: "integration-test",
    currentState: "initial",
    version: 0,
    definitionVersion: null,
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
      await client.query("DROP TABLE IF EXISTS workflow_history, workflow_instances, workflow_definitions CASCADE");
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

  runDefinitionStoreConformance("pg (real PostgreSQL)", {
    setup: async () => ({
      store: definitionStore,
      teardown: async () => {
        await pool.query("TRUNCATE workflow_definitions");
      },
    }),
  });

  describe("pg adapter integration", () => {
    // Cleanup runs in afterEach (not at the end of each test body) so a
    // failing assertion cannot leak rows into the next test.
    afterEach(async () => {
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      await pool.query("TRUNCATE workflow_definitions");
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

    it("round-trips instance definitionVersion through create, update and findByUuid", async () => {
      const instance = makeInstance({ definitionVersion: 4 });
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));
      let fetched = await instanceStore.findByUuid(instance.uuid);
      expect(fetched!.definitionVersion).toBe(4);

      fetched!.definitionVersion = 5;
      fetched!.version++;
      await transactionRunner.runInTransaction(() => instanceStore.update(fetched!));
      fetched = await instanceStore.findByUuid(instance.uuid);
      expect(fetched!.definitionVersion).toBe(5);
    });

    it("round-trips history definitionVersion", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));
      await historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: "a",
        eventName: "Go",
        toState: "b",
        outcome: "success",
        commandResultsJson: [],
        definitionVersion: 3,
      });
      const [record] = await historyStore.findByInstanceUuid(instance.uuid);
      expect(record.definitionVersion).toBe(3);
    });

    it("round-trips history createdAt as a Date assigned by the database", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));

      const before = Date.now();
      await historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: "a",
        eventName: "Go",
        toState: "b",
        outcome: "success",
        commandResultsJson: [],
      });
      const after = Date.now();

      const [record] = await historyStore.findByInstanceUuid(instance.uuid);
      expect(record.createdAt).toBeInstanceOf(Date);
      // The database assigns created_at via `now()`, so it must fall within the
      // wall-clock window the append() call actually executed in.
      expect(record.createdAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(record.createdAt!.getTime()).toBeLessThanOrEqual(after + 1000);
    });
  });

  describe("pg transaction timeouts", () => {
    afterEach(async () => {
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
    });

    const showSetting = async (runner: PgTransactionRunner, setting: string): Promise<string> =>
      runner.runInTransaction(async () => {
        const client = PgTransactionContext.getClient(pool)!;
        const result = await client.query(`SHOW ${setting}`);
        return result.rows[0][setting] as string;
      });

    it("applies both timeouts inside the transaction and reverts them on commit", async () => {
      const bounded = new PgTransactionRunner(pool, { lockTimeoutMs: 3000, statementTimeoutMs: 30000 });

      expect(await showSetting(bounded, "lock_timeout")).toBe("3s");
      expect(await showSetting(bounded, "statement_timeout")).toBe("30s");

      // SET LOCAL is undone at COMMIT, so an unconfigured runner sharing the same
      // pool must still see the server defaults.
      expect(await showSetting(transactionRunner, "lock_timeout")).toBe("0");
      expect(await showSetting(transactionRunner, "statement_timeout")).toBe("0");
    });

    it("emits nothing when no timeouts are configured", async () => {
      expect(await showSetting(transactionRunner, "lock_timeout")).toBe("0");
    });

    it("lock_timeout aborts a FOR UPDATE that another transaction is blocking", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));

      // Hold the row from a second connection so lockByUuid has to wait.
      const blocker = await pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT * FROM workflow_instances WHERE uuid = $1 FOR UPDATE", [instance.uuid]);

        const bounded = new PgTransactionRunner(pool, { lockTimeoutMs: 250 });
        // Without lock_timeout this call would wait for the blocker forever while
        // holding a pooled connection; with it, the wait is bounded.
        await expect(bounded.runInTransaction(() => instanceStore.lockByUuid(instance.uuid))).rejects.toThrow(
          /lock timeout/i,
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    });
  });
}
