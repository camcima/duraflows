import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  type WorkflowDatabase,
} from "@duraflows/kysely";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
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
    it("findExpired executes and claims only expired rows", async () => {
      const expired = makeInstance({ expiresAt: new Date("2020-01-01T00:00:00Z") });
      const future = makeInstance({ expiresAt: new Date("2099-01-01T00:00:00Z") });
      await transactionRunner.runInTransaction(async () => {
        await instanceStore.create(expired);
        await instanceStore.create(future);
      });

      const found = await transactionRunner.runInTransaction(() => instanceStore.findExpired(10, new Date()));

      expect(found.map((i) => i.uuid)).toEqual([expired.uuid]);
      await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
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
      await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
    });
  });
}
