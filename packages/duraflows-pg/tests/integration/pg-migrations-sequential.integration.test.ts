import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import type { WorkflowDefinition } from "@duraflows/core";
import {
  PgWorkflowInstanceStore,
  PgWorkflowHistoryStore,
  PgWorkflowDefinitionStore,
  PgTransactionRunner,
} from "@duraflows/pg";

// This suite proves that the four *shipped* dbmate migration artifacts, applied
// in order against a real database, produce a schema the adapters can write
// to. `pg-adapter.integration.test.ts` and its kysely equivalent both bootstrap
// from `generateMigrationSql()` (the fresh-install path) — neither ever runs
// the incremental `ALTER TABLE` migrations in `sql/dbmate/`. Reading the files
// off disk (rather than pasting their SQL here) keeps this test honest as the
// migrations evolve: if a future migration file drifts from what the runtime
// needs, this test fails against the real artifact, not a copy of it.

const databaseUrl = process.env.DATABASE_URL;

const MIGRATION_FILENAMES = [
  "001_workflow_core.sql",
  "002_replace_trigger_with_metadata.sql",
  "003_event_guards.sql",
  "004_definition_versions.sql",
];

const dbmateDir = fileURLToPath(new URL("../../sql/dbmate/", import.meta.url));

/**
 * Extracts the `-- migrate:up` half of a dbmate migration file. dbmate files
 * always have exactly one `-- migrate:up` marker followed by exactly one
 * `-- migrate:down` marker; only the SQL between them is applied here.
 */
function extractUpSql(filename: string): string {
  const raw = readFileSync(path.join(dbmateDir, filename), "utf8");
  const upMarker = "-- migrate:up";
  const downMarker = "-- migrate:down";
  const upIndex = raw.indexOf(upMarker);
  const downIndex = raw.indexOf(downMarker);
  if (upIndex === -1 || downIndex === -1 || downIndex < upIndex) {
    throw new Error(`${filename}: expected both "${upMarker}" and "${downMarker}" markers`);
  }
  return raw.slice(upIndex + upMarker.length, downIndex);
}

if (!databaseUrl && process.env.REQUIRE_INTEGRATION_DB === "1") {
  // Mirrors pg-adapter.integration.test.ts: CI sets REQUIRE_INTEGRATION_DB=1,
  // so a missing DATABASE_URL there means the database is unavailable rather
  // than "no database configured" -- fail loudly instead of silently
  // skipping this suite's coverage of the sequential dbmate migrations.
  describe("pg sequential dbmate migrations", () => {
    it("fails because REQUIRE_INTEGRATION_DB is set but DATABASE_URL is not", () => {
      throw new Error(
        "REQUIRE_INTEGRATION_DB=1 but DATABASE_URL is not set: the integration database is unavailable, " +
          "so the sequential dbmate migrations suite cannot run.",
      );
    });
  });
} else if (!databaseUrl) {
  describe.skip("pg sequential dbmate migrations (set DATABASE_URL to run)", () => {
    it.skip("skipped", () => {});
  });
} else {
  // Dedicated schema, distinct from `duraflows_pg_it` (used by
  // pg-adapter.integration.test.ts), so this suite's DDL/DML can never
  // disturb the other suite's schema or its `generateMigrationSql()`
  // bootstrap even when both run against the same database concurrently.
  const pool = new Pool({ connectionString: databaseUrl, options: "-c search_path=duraflows_pg_it_migrations" });
  const transactionRunner = new PgTransactionRunner(pool);
  const instanceStore = new PgWorkflowInstanceStore(pool);
  const historyStore = new PgWorkflowHistoryStore(pool);
  const definitionStore = new PgWorkflowDefinitionStore(pool);

  beforeAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS duraflows_pg_it_migrations");
      await client.query("DROP TABLE IF EXISTS workflow_history, workflow_instances, workflow_definitions CASCADE");
      for (const filename of MIGRATION_FILENAMES) {
        await client.query(extractUpSql(filename));
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS duraflows_pg_it_migrations CASCADE");
    } finally {
      client.release();
    }
    await pool.end();
  });

  describe("pg sequential dbmate migrations (001 -> 004 applied in order)", () => {
    it("produces a schema the instance store can write to, including definitionVersion", async () => {
      const instance = {
        uuid: randomUUID(),
        workflowName: "sequential-migration-test",
        currentState: "initial",
        version: 0,
        definitionVersion: 7,
        expiresAt: null,
        lastTransitionAt: new Date("2026-01-01T00:00:00Z"),
        context: {},
        metadata: {},
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };

      await transactionRunner.runInTransaction(() => instanceStore.create(instance));
      const fetched = await instanceStore.findByUuid(instance.uuid);
      expect(fetched).not.toBeNull();
      expect(fetched!.definitionVersion).toBe(7);
    });

    it("produces a schema the history store can write to, including definitionVersion", async () => {
      const instance = {
        uuid: randomUUID(),
        workflowName: "sequential-migration-test",
        currentState: "initial",
        version: 0,
        definitionVersion: null,
        expiresAt: null,
        lastTransitionAt: new Date("2026-01-01T00:00:00Z"),
        context: {},
        metadata: {},
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));

      await historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: "initial",
        eventName: "Go",
        toState: "next",
        outcome: "success",
        commandResultsJson: [],
        definitionVersion: 2,
      });

      const [record] = await historyStore.findByInstanceUuid(instance.uuid);
      expect(record.definitionVersion).toBe(2);
    });

    it("produces a schema the definition store can write to and read back", async () => {
      const definitionJson: WorkflowDefinition = {
        name: "sequential-migration-test",
        version: 1,
        initialState: "start",
        states: {
          start: { events: { Go: { targetState: "done" } } },
          done: {},
        },
      };

      const ensured = await definitionStore.ensure({
        workflowName: "sequential-migration-test",
        version: 1,
        contentHash: `sha256:${"cd".repeat(32)}`,
        definitionJson,
      });
      expect(ensured.workflowName).toBe("sequential-migration-test");
      expect(ensured.version).toBe(1);

      const found = await definitionStore.findByNameAndVersion("sequential-migration-test", 1);
      expect(found).not.toBeNull();
      expect(found!.contentHash).toBe(`sha256:${"cd".repeat(32)}`);
      expect(found!.definitionJson).toEqual(definitionJson);
    });
  });
}
