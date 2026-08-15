import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { runInstanceStoreConformance } from "@duraflows/core/testing";
import type { WorkflowInstance } from "@duraflows/core";
import { generateMigrationSql } from "@duraflows/pg";
import {
  KyselyWorkflowInstanceStore,
  KyselyWorkflowHistoryStore,
  KyselyTransactionRunner,
  KyselyTransactionContext,
  type WorkflowDatabase,
} from "@duraflows/kysely";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl && process.env.REQUIRE_INTEGRATION_DB === "1") {
  // CI sets REQUIRE_INTEGRATION_DB=1. There, a missing DATABASE_URL means the
  // service container or the secret broke — and silently skipping every
  // real-SQL test would hand back a green badge with zero integration
  // coverage. Fail loudly instead. Locally the flag is unset, so a developer
  // without a database still gets the skip below.
  describe("kysely adapter integration", () => {
    it("fails because REQUIRE_INTEGRATION_DB is set but DATABASE_URL is not", () => {
      throw new Error(
        "REQUIRE_INTEGRATION_DB=1 but DATABASE_URL is not set: the integration database is unavailable, " +
          "so the kysely adapter integration suite cannot run.",
      );
    });
  });
} else if (!databaseUrl) {
  describe.skip("kysely adapter integration (set DATABASE_URL to run)", () => {
    it.skip("skipped", () => {});
  });
} else {
  // `options` sets the backend `search_path` as a startup parameter, applied at
  // connection establishment for EVERY pooled connection before any query runs.
  // This isolates this suite's tables in a dedicated schema without relying on a
  // fire-and-forget `pool.on("connect")` handler (which is not awaited and races
  // with the first query on a freshly opened connection). The path is kysely_it
  // ONLY (no `public`) so unqualified DDL here can't fall through and drop the
  // pg suite's public-schema tables when both suites run in parallel; built-ins
  // like gen_random_uuid() resolve from pg_catalog regardless.
  const pool = new Pool({ connectionString: databaseUrl, options: "-c search_path=kysely_it" });
  const db = new Kysely<WorkflowDatabase>({ dialect: new PostgresDialect({ pool }) });
  const transactionRunner = new KyselyTransactionRunner(db);
  const instanceStore = new KyselyWorkflowInstanceStore(db);
  const historyStore = new KyselyWorkflowHistoryStore(db);

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
    // Bootstrap the dedicated schema on a single pg client. `generateMigrationSql`
    // returns a multi-statement string, which Kysely's `sql.execute()` cannot run
    // (the wire protocol returns one result set), so a raw client is used here.
    // The pool's `search_path` startup option (kysely_it) already points every
    // connection at this schema; CREATE SCHEMA below is unqualified-DDL-safe.
    const client = await pool.connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS kysely_it");
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
      await client.query("DROP SCHEMA IF EXISTS kysely_it CASCADE");
    } finally {
      client.release();
    }
    await db.destroy();
  });

  runInstanceStoreConformance("kysely (real PostgreSQL)", {
    setup: async () => ({
      store: instanceStore,
      transactionRunner,
      teardown: async () => {
        await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
      },
    }),
  });

  describe("kysely adapter integration", () => {
    // Cleanup runs in afterEach (not at the end of each test body) so a
    // failing assertion cannot leak rows into the next test.
    afterEach(async () => {
      await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
    });

    it("findExpired executes and claims only expired rows", async () => {
      const expired = makeInstance({ expiresAt: new Date("2020-01-01T00:00:00Z") });
      const future = makeInstance({ expiresAt: new Date("2099-01-01T00:00:00Z") });
      await transactionRunner.runInTransaction(async () => {
        await instanceStore.create(expired);
        await instanceStore.create(future);
      });

      const found = await transactionRunner.runInTransaction(() => instanceStore.findExpired(10, new Date()));

      expect(found.map((i) => i.uuid)).toEqual([expired.uuid]);
    });

    it("history maps NULL rejected_by/error_message to undefined", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));
      await transactionRunner.runInTransaction(() =>
        historyStore.append({
          workflowInstanceUuid: instance.uuid,
          fromState: null,
          eventName: "__create__",
          toState: "initial",
          outcome: "success",
          commandResultsJson: [],
        }),
      );
      const [record] = await historyStore.findByInstanceUuid(instance.uuid);
      expect(record.rejectedBy).toBeUndefined();
      expect(record.errorMessage).toBeUndefined();
    });
  });

  describe("kysely transaction timeouts", () => {
    afterEach(async () => {
      await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
    });

    const showLockTimeout = async (runner: KyselyTransactionRunner): Promise<string> =>
      runner.runInTransaction(async () => {
        const trx = KyselyTransactionContext.getTransaction(db)!;
        const result = await sql<{ lock_timeout: string }>`SHOW lock_timeout`.execute(trx);
        return result.rows[0].lock_timeout;
      });

    it("applies the timeout inside the transaction and reverts it on commit", async () => {
      const bounded = new KyselyTransactionRunner(db, { lockTimeoutMs: 3000 });

      expect(await showLockTimeout(bounded)).toBe("3s");
      // set_config(..., is_local => true) is undone at COMMIT, so an unconfigured
      // runner sharing the same pool must still see the server default.
      expect(await showLockTimeout(transactionRunner)).toBe("0");
    });

    it("lock_timeout aborts a FOR UPDATE that another transaction is blocking", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));

      // Hold the row from a second connection so lockByUuid has to wait.
      const blocker = await pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT * FROM workflow_instances WHERE uuid = $1 FOR UPDATE", [instance.uuid]);

        const bounded = new KyselyTransactionRunner(db, { lockTimeoutMs: 250 });
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
