import { runDatabaseDurableCases } from "../../../duraflows-core/tests/helpers/database-durable-cases.js";
import { runDatabaseIdempotencyCases } from "../../../duraflows-core/tests/helpers/database-idempotency-cases.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  runInstanceStoreConformance,
  runDefinitionStoreConformance,
  runTransactionRunnerConformance,
} from "@duraflows/core/testing";
import type {
  WorkflowInstance,
  WorkflowHistoryRecord,
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
} from "@duraflows/core";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  WorkflowValidator,
  WorkflowCompiler,
  WorkflowError,
} from "@duraflows/core";
import {
  PgWorkflowInstanceStore,
  PgWorkflowHistoryStore,
  PgTransactionRunner,
  PgTransactionContext,
  generateMigrationSql,
  pgWorkflowProviders,
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
    timeoutRetry: null,
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
      const { up } = generateMigrationSql({ includeIdempotency: true, includeDurableExecution: true });
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

  runDatabaseDurableCases(
    "pg",
    () => pgWorkflowProviders(pool, { durableExecution: true }),
    async (uuid) => {
      const { rows } = await pool.query<{ lease_until: Date | null }>(
        "SELECT lease_until FROM workflow_executions WHERE uuid = $1",
        [uuid],
      );
      expect(rows).toHaveLength(1);
      return rows[0].lease_until;
    },
    async () => {
      await pool.query("TRUNCATE workflow_history, workflow_instances, workflow_definitions CASCADE");
    },
  );

  runDatabaseIdempotencyCases("pg", () => pgWorkflowProviders(pool, { idempotency: true }));

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

  runTransactionRunnerConformance("pg (real PostgreSQL)", {
    setup: async () => ({
      runner: transactionRunner,
      store: instanceStore,
      failWithDatabaseError: async () => {
        await PgTransactionContext.getClient(pool)!.query("SELECT 1/0");
      },
      teardown: async () => {
        await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      },
    }),
  });

  describe("pg runtime inside an outer transaction", () => {
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    const observed: string[] = [];

    function buildRuntime(): WorkflowRuntime {
      const definitionRegistry = new InMemoryDefinitionRegistry({
        validator: new WorkflowValidator(),
        compiler: new WorkflowCompiler(),
      });
      const commandRegistry = new InMemoryCommandRegistry();
      definitionRegistry.register({
        name: "flow",
        initialState: "start",
        states: {
          start: {
            events: { go: { targetState: "done" }, expire: { targetState: "mid", timeout: { afterMinutes: 1 } } },
          },
          mid: { onEnter: { commands: [{ name: "boom" }] } },
          done: {},
        },
      });
      definitionRegistry.register({
        name: "healthy",
        initialState: "start",
        states: {
          start: { events: { expire: { targetState: "finished", timeout: { afterMinutes: 1 } } } },
          finished: {},
        },
      });
      commandRegistry.register("boom", {
        execute: async () => {
          throw new Error("js boom");
        },
      });
      return new WorkflowRuntime({
        definitionRegistry,
        commandRegistry,
        ...pgWorkflowProviders(pool),
        clock: { now: () => new Date(now) },
        observers: [{ name: "recorder", onEnter: (event) => void observed.push(event.toState) }],
      });
    }

    afterEach(async () => {
      observed.length = 0;
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      await pool.query("TRUNCATE workflow_definitions");
    });

    it("fires no observer when the outer transaction rolls back", async () => {
      const runtime = buildRuntime();
      const instance = await runtime.createInstance({ workflowName: "flow" });
      observed.length = 0;

      await expect(
        PgTransactionContext.transaction(pool, async () => {
          await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");

      expect(observed).toEqual([]);
      expect((await runtime.getInstance(instance.uuid))!.currentState).toBe("start");
    });

    it("fires the observer once, after COMMIT, through PgTransactionContext.transaction", async () => {
      const runtime = buildRuntime();
      const instance = await runtime.createInstance({ workflowName: "flow" });
      observed.length = 0;

      await PgTransactionContext.transaction(pool, async () => {
        await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });
        expect(observed).toEqual([]);
      });

      expect(observed).toEqual(["done"]);
    });

    it("a nested sweep commits nothing for an instance whose onEnter throws", async () => {
      const runtime = buildRuntime();
      const instance = await runtime.createInstance({ workflowName: "flow" });
      const historyBefore = await runtime.getHistory(instance.uuid);
      now += 5 * 60_000;

      const result = await transactionRunner.runInTransaction(() => runtime.processExpiredWorkflows());

      expect(result.failed.map((f) => f.uuid)).toEqual([instance.uuid]);
      expect(result.failed[0]!.attempts).toBe(1);
      const after = (await runtime.getInstance(instance.uuid))!;
      expect(after.currentState).toBe("start");
      expect(after.timeoutRetry).not.toBeNull();
      expect(await runtime.getHistory(instance.uuid)).toHaveLength(historyBefore.length);
    });

    it("a nested sweep commits a healthy instance and fires its observer only after the outer commit", async () => {
      const runtime = buildRuntime();
      const failing = await runtime.createInstance({ workflowName: "flow" });
      const healthy = await runtime.createInstance({ workflowName: "healthy" });
      observed.length = 0;
      now += 5 * 60_000;

      const result = await transactionRunner.runInTransaction(async () => {
        const sweep = await runtime.processExpiredWorkflows();
        expect(observed).toEqual([]);
        return sweep;
      });

      expect(result.failed.map((f) => f.uuid)).toEqual([failing.uuid]);
      expect((await runtime.getInstance(healthy.uuid))!.currentState).toBe("finished");
      expect((await runtime.getInstance(failing.uuid))!.currentState).toBe("start");
      expect(observed).toEqual(["finished"]);
    });

    it("a nested call that swallows a SQL error rejects instead of reporting success", async () => {
      await expect(
        transactionRunner.runInTransaction(async () => {
          await transactionRunner.runInTransaction(async () => {
            try {
              await PgTransactionContext.getClient(pool)!.query("SELECT 1/0");
            } catch {
              // swallowed on purpose: the transaction is now aborted
            }
          });
        }),
      ).rejects.toThrow(/current transaction is aborted/);
    });
  });

  describe("pg timeout retry scheduling", () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    let now = start;

    function buildRuntime(): WorkflowRuntime {
      const definitionRegistry = new InMemoryDefinitionRegistry({
        validator: new WorkflowValidator(),
        compiler: new WorkflowCompiler(),
      });
      const commandRegistry = new InMemoryCommandRegistry();
      definitionRegistry.register({
        name: "broken",
        initialState: "start",
        states: {
          start: {
            events: { expire: { targetState: "done", commands: [{ name: "boom" }], timeout: { afterMinutes: 1 } } },
          },
          done: {},
        },
      });
      definitionRegistry.register({
        name: "healthy",
        initialState: "start",
        states: { start: { events: { expire: { targetState: "done", timeout: { afterMinutes: 1 } } } }, done: {} },
      });
      definitionRegistry.register({
        name: "nul-error",
        initialState: "start",
        states: {
          start: {
            events: {
              expire: { targetState: "done", commands: [{ name: "nulBoom" }], timeout: { afterMinutes: 1 } },
            },
          },
          done: {},
        },
      });
      commandRegistry.register("boom", {
        execute: async () => {
          throw new Error("js boom");
        },
      });
      commandRegistry.register("nulBoom", {
        execute: async () => {
          throw new Error("bad\u0000byte");
        },
      });
      return new WorkflowRuntime({
        definitionRegistry,
        commandRegistry,
        ...pgWorkflowProviders(pool),
        clock: { now: () => new Date(now) },
        timeoutRetry: { initialDelayMs: 60_000, maxDelayMs: 240_000, maxAttempts: 2 },
      });
    }

    afterEach(async () => {
      now = start;
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      await pool.query("TRUNCATE workflow_definitions");
    });

    it("lets healthy instances progress past failing ones", async () => {
      const runtime = buildRuntime();
      for (let i = 0; i < 3; i++) await runtime.createInstance({ workflowName: "broken" });
      now += 1000;
      const healthy = [
        await runtime.createInstance({ workflowName: "healthy" }),
        await runtime.createInstance({ workflowName: "healthy" }),
      ];
      now += 5 * 60_000;

      for (let sweep = 0; sweep < 3; sweep++) await runtime.processExpiredWorkflows({ limit: 2 });

      for (const h of healthy) expect((await runtime.getInstance(h.uuid))!.currentState).toBe("done");
    });

    it("keeps retry scheduling and parking across a worker restart", async () => {
      const first = buildRuntime();
      const instance = await first.createInstance({ workflowName: "broken" });
      now += 5 * 60_000;
      await first.processExpiredWorkflows();

      const restarted = buildRuntime();
      expect((await restarted.processExpiredWorkflows()).failed).toEqual([]);

      now += 60_000 + 1;
      const parkedSweep = await restarted.processExpiredWorkflows();
      expect(parkedSweep.parked.map((p) => p.uuid)).toEqual([instance.uuid]);
      expect(parkedSweep.failed).toEqual([{ uuid: instance.uuid, error: "js boom", attempts: 2, retryAt: null }]);

      const another = buildRuntime();
      expect((await another.findParkedTimeouts()).map((i) => i.uuid)).toEqual([instance.uuid]);
      now += 600 * 60_000;
      expect((await another.processExpiredWorkflows()).failed).toEqual([]);
    });

    it("records a failure whose error message contains a NUL character", async () => {
      const runtime = buildRuntime();
      const instance = await runtime.createInstance({ workflowName: "nul-error" });
      now += 5 * 60_000;

      const { failed } = await runtime.processExpiredWorkflows();

      expect(failed.map((f) => f.uuid)).toEqual([instance.uuid]);
      expect(failed[0]!.attempts).toBe(1);
      const lastError = (await runtime.getInstance(instance.uuid))!.timeoutRetry!.lastError;
      expect(lastError).toContain("\uFFFD");
      expect(lastError).not.toContain("\u0000");
    });
  });

  describe("pg instance migration", () => {
    const v1: WorkflowDefinition = {
      name: "migrating-order",
      initialState: "new",
      states: {
        new: { events: { Submit: { targetState: "review" } } },
        review: { events: { Approve: { targetState: "approved" } } },
        approved: {},
      },
    };
    const v2: WorkflowDefinition = {
      name: "migrating-order",
      version: 2,
      initialState: "new",
      states: {
        new: { events: { Submit: { targetState: "checking" } } },
        checking: { events: { Approve: { targetState: "accepted" } } },
        accepted: {},
      },
    };

    function buildRuntime(definition: WorkflowDefinition): WorkflowRuntime {
      const definitionRegistry = new InMemoryDefinitionRegistry({
        validator: new WorkflowValidator(),
        compiler: new WorkflowCompiler(),
      });
      definitionRegistry.register(definition);
      return new WorkflowRuntime({
        definitionRegistry,
        commandRegistry: new InMemoryCommandRegistry(),
        ...pgWorkflowProviders(pool),
        clock: { now: () => new Date() },
      });
    }

    afterEach(async () => {
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      await pool.query("TRUNCATE workflow_definitions");
    });

    // This case performs hundreds of SQL operations; allow it to finish before cleanup under load.
    it("pages through every v1 instance, relabels them and records $migrated", async () => {
      const runtimeV1 = buildRuntime(v1);
      const uuids: string[] = [];
      for (let i = 0; i < 105; i++) {
        const instance = await runtimeV1.createInstance({ workflowName: "migrating-order" });
        await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
        uuids.push(instance.uuid);
      }

      const runtimeV2 = buildRuntime(v2);
      const dry = await runtimeV2.migrateInstances({
        workflowName: "migrating-order",
        fromVersion: 1,
        toVersion: 2,
        stateMapping: { review: "checking" },
        dryRun: true,
      });
      expect(dry.migrated).toHaveLength(105);

      const result = await runtimeV2.migrateInstances({
        workflowName: "migrating-order",
        fromVersion: 1,
        toVersion: 2,
        stateMapping: { review: "checking" },
      });

      expect(result.migrated).toHaveLength(105);
      expect(result.skipped).toEqual([]);
      expect(result.failed).toEqual([]);
      const sample = (await runtimeV2.getInstance(uuids[0]))!;
      expect([sample.currentState, sample.definitionVersion]).toEqual(["checking", 2]);
      const row = (await runtimeV2.getHistory(uuids[0])).find((h) => h.eventName === "$migrated");
      expect(row).toMatchObject({
        fromState: "review",
        toState: "checking",
        definitionVersion: 2,
        triggerMetadata: { source: "migration", fromVersion: 1, toVersion: 2 },
      });
      const versions = await runtimeV2.listDefinitionVersions("migrating-order");
      expect(versions.map((v) => [v.version, v.activeInstances])).toEqual([
        [1, 0],
        [2, 105],
      ]);
      await runtimeV2.triggerEvent({ workflowInstanceUuid: uuids[0], eventName: "Approve" });
      expect((await runtimeV2.getInstance(uuids[0]))!.currentState).toBe("accepted");
    }, 30_000);

    it("filters by state in the query and finishes with a cursor loop", async () => {
      const runtimeV1 = buildRuntime(v1);
      const approved: string[] = [];
      const reviewing: string[] = [];
      for (let i = 0; i < 30; i++) {
        const instance = await runtimeV1.createInstance({ workflowName: "migrating-order" });
        await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
        if (i % 3 === 0) {
          await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Approve" });
          approved.push(instance.uuid);
        } else {
          reviewing.push(instance.uuid);
        }
      }

      const runtimeV2 = buildRuntime(v2);
      const migrated: string[] = [];
      const skipped: unknown[] = [];
      let cursor: string | undefined;
      do {
        const batch = await runtimeV2.migrateInstances({
          workflowName: "migrating-order",
          fromVersion: 1,
          toVersion: 2,
          stateMapping: { review: "checking" },
          excludeStates: ["approved"],
          limit: 7,
          cursor,
        });
        migrated.push(...batch.migrated.map((m) => m.uuid));
        skipped.push(...batch.skipped);
        cursor = batch.nextCursor ?? undefined;
      } while (cursor);

      expect(skipped).toEqual([]);
      expect([...migrated].sort()).toEqual([...reviewing].sort());
      for (const uuid of approved) {
        expect((await runtimeV2.getInstance(uuid))!.definitionVersion).toBe(1);
      }
    });
  });

  describe("pg definition snapshots and caller-owned transactions", () => {
    const definition: WorkflowDefinition = {
      name: "sync-rollback",
      initialState: "open",
      states: { open: { events: { Close: { targetState: "closed" } } }, closed: {} },
    };

    function build() {
      const providers = pgWorkflowProviders(pool);
      const definitionRegistry = new InMemoryDefinitionRegistry({
        validator: new WorkflowValidator(),
        compiler: new WorkflowCompiler(),
      });
      definitionRegistry.register(definition);
      const runtime = new WorkflowRuntime({
        definitionRegistry,
        commandRegistry: new InMemoryCommandRegistry(),
        ...providers,
        clock: { now: () => new Date() },
      });
      return { runtime, providers };
    }

    const snapshots = async () =>
      (
        await pool.query("SELECT count(*)::int AS n FROM workflow_definitions WHERE workflow_name = $1", [
          "sync-rollback",
        ])
      ).rows[0].n as number;

    afterEach(async () => {
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      await pool.query("TRUNCATE workflow_definitions");
    });

    it("restores a snapshot whose first sync was rolled back with the caller's transaction", async () => {
      const { runtime, providers } = build();

      await providers.transactionRunner
        .runInTransaction(async () => {
          await runtime.createInstance({ workflowName: "sync-rollback" });
          throw new Error("caller rolls back");
        })
        .catch(() => undefined);
      expect(await snapshots()).toBe(0);

      await runtime.createInstance({ workflowName: "sync-rollback" });
      expect(await snapshots()).toBe(1);
    });

    it("writes the snapshot with the instance in a transaction the caller owns and rolls back", async () => {
      const { runtime } = build();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await PgTransactionContext.run(pool, client, () => runtime.createInstance({ workflowName: "sync-rollback" }));
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await snapshots()).toBe(0);

      const instance = await runtime.createInstance({ workflowName: "sync-rollback" });

      expect(await snapshots()).toBe(1);
      expect(await runtime.getInstance(instance.uuid)).not.toBeNull();
    });

    it("persists the snapshot even when a custom registry returns a fresh object on every get()", async () => {
      const inner = new InMemoryDefinitionRegistry();
      inner.register(definition);
      const cloningRegistry: WorkflowDefinitionRegistry = {
        get: (name) => structuredClone(inner.get(name)),
        has: (name) => inner.has(name),
        getAll: () => inner.getAll().map((d) => structuredClone(d)),
      };
      const providers = pgWorkflowProviders(pool);
      const runtime = new WorkflowRuntime({
        definitionRegistry: cloningRegistry,
        commandRegistry: new InMemoryCommandRegistry(),
        ...providers,
        clock: { now: () => new Date() },
      });

      await providers.transactionRunner
        .runInTransaction(async () => {
          await runtime.createInstance({ workflowName: "sync-rollback" });
          throw new Error("caller rolls back");
        })
        .catch(() => undefined);
      expect(await snapshots()).toBe(0);

      await runtime.createInstance({ workflowName: "sync-rollback" });
      expect(await snapshots()).toBe(1);
    });

    it("re-establishes a cached migration target whose snapshot row was rolled back", async () => {
      const versioned = (version: number): WorkflowDefinition => ({
        ...definition,
        version,
        states: { ...definition.states, open: { events: { Close: { targetState: "closed" } }, metadata: { version } } },
      });
      const build = (def: WorkflowDefinition) => {
        const registry = new InMemoryDefinitionRegistry();
        registry.register(def);
        return new WorkflowRuntime({
          definitionRegistry: registry,
          commandRegistry: new InMemoryCommandRegistry(),
          ...pgWorkflowProviders(pool),
          clock: { now: () => new Date() },
        });
      };
      const instance = await build(versioned(1)).createInstance({ workflowName: "sync-rollback" });
      const runtimeV3 = build(versioned(3));
      await runtimeV3.initialize();
      const toV2 = { workflowName: "sync-rollback", fromVersion: 1, toVersion: 2 };

      // v2's row only exists inside this transaction; the migration loads (and caches) it, then all rolls back.
      await pgWorkflowProviders(pool)
        .transactionRunner.runInTransaction(async () => {
          await build(versioned(2)).initialize();
          await runtimeV3.migrateInstances(toV2);
          throw new Error("caller rolls back");
        })
        .catch(() => undefined);

      const retry = await runtimeV3.migrateInstances(toV2);

      expect(retry.migrated.map((m) => m.uuid)).toEqual([instance.uuid]);
      const v2Rows = await pool.query(
        "SELECT count(*)::int AS n FROM workflow_definitions WHERE workflow_name = $1 AND version = 2",
        ["sync-rollback"],
      );
      expect(v2Rows.rows[0].n).toBe(1);
      await build(versioned(3)).triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Close" });
      expect((await runtimeV3.getInstance(instance.uuid))!.currentState).toBe("closed");
    });

    it("refuses a cached migration target that no longer matches the committed version", async () => {
      const build = (def: WorkflowDefinition) => {
        const registry = new InMemoryDefinitionRegistry();
        registry.register(def);
        return new WorkflowRuntime({
          definitionRegistry: registry,
          commandRegistry: new InMemoryCommandRegistry(),
          ...pgWorkflowProviders(pool),
          clock: { now: () => new Date() },
        });
      };
      const v2Open: WorkflowDefinition = { ...definition, version: 2 };
      const v2Replacement: WorkflowDefinition = {
        name: "sync-rollback",
        version: 2,
        initialState: "replacement",
        states: { replacement: { events: { Close: { targetState: "closed" } } }, closed: {} },
      };
      const instance = await build(definition).createInstance({ workflowName: "sync-rollback" });
      const runtimeV3 = build({ ...definition, version: 3 });
      await runtimeV3.initialize();
      const toV2 = { workflowName: "sync-rollback", fromVersion: 1, toVersion: 2 };

      // Cache v2 ("open") from a row that then rolls back; different v2 content is committed afterwards.
      await pgWorkflowProviders(pool)
        .transactionRunner.runInTransaction(async () => {
          await build(v2Open).initialize();
          await runtimeV3.migrateInstances(toV2);
          throw new Error("caller rolls back");
        })
        .catch(() => undefined);
      await build(v2Replacement).initialize();

      const stale = await runtimeV3.migrateInstances(toV2);

      expect(stale.migrated).toEqual([]);
      expect(stale.failed).toEqual([
        { uuid: instance.uuid, error: expect.stringMatching(/stored version 2 differs from the copy loaded earlier/) },
      ]);
      expect((await runtimeV3.getInstance(instance.uuid))!.definitionVersion).toBe(1);

      // The retry reloads the committed v2 and plans against it.
      const retry = await runtimeV3.migrateInstances({ ...toV2, stateMapping: { open: "replacement" } });
      expect(retry.migrated).toEqual([{ uuid: instance.uuid, fromState: "open", toState: "replacement" }]);
      await build({ ...definition, version: 3 }).triggerEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "Close",
      });
      expect((await runtimeV3.getInstance(instance.uuid))!.currentState).toBe("closed");
    });

    it("runs a pinned instance on the committed version, not a copy cached from a rolled-back row", async () => {
      const build = (def: WorkflowDefinition) => {
        const registry = new InMemoryDefinitionRegistry();
        registry.register(def);
        return new WorkflowRuntime({
          definitionRegistry: registry,
          commandRegistry: new InMemoryCommandRegistry(),
          ...pgWorkflowProviders(pool),
          clock: { now: () => new Date() },
        });
      };
      const v2WithoutHold: WorkflowDefinition = { ...definition, version: 2 };
      const v2WithHold: WorkflowDefinition = {
        name: "sync-rollback",
        version: 2,
        initialState: "open",
        states: {
          open: { events: { Close: { targetState: "closed" }, Hold: { targetState: "held" } } },
          held: {},
          closed: {},
        },
      };
      const runtimeV3 = build({ ...definition, version: 3 });
      await runtimeV3.initialize();

      // runtimeV3 caches v2 (no Hold) from a row that then rolls back.
      await pgWorkflowProviders(pool)
        .transactionRunner.runInTransaction(async () => {
          const doomed = await build(v2WithoutHold).createInstance({ workflowName: "sync-rollback" });
          await runtimeV3.getAvailableEvents({ workflowInstanceUuid: doomed.uuid });
          throw new Error("caller rolls back");
        })
        .catch(() => undefined);
      const instance = await build(v2WithHold).createInstance({ workflowName: "sync-rollback" });

      await runtimeV3.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Hold" });

      expect((await runtimeV3.getInstance(instance.uuid))!.currentState).toBe("held");
    });

    it("gives an instance created during another request's rolled-back sync its own snapshot", async () => {
      const { runtime, providers } = build();
      let markSynced!: () => void;
      const aSynced = new Promise<void>((resolve) => {
        markSynced = resolve;
      });
      let markBStarted!: () => void;
      const bStarted = new Promise<void>((resolve) => {
        markBStarted = resolve;
      });

      // Request A syncs inside its own transaction, then rolls back after B has started.
      const requestA = providers.transactionRunner
        .runInTransaction(async () => {
          await runtime.initialize();
          markSynced();
          await bStarted;
          await new Promise((resolve) => setTimeout(resolve, 100));
          throw new Error("request A rolls back");
        })
        .catch(() => undefined);
      await aSynced;
      const requestB = runtime.createInstance({ workflowName: "sync-rollback" });
      markBStarted();
      const [, instance] = await Promise.all([requestA, requestB]);

      expect(await snapshots()).toBe(1);
      expect(await runtime.getInstance(instance.uuid)).not.toBeNull();
    });
  });

  describe("pg definition version pinning", () => {
    // v1 omits `version` (defaults to 1). v2 renames the review state and
    // retargets Approve, so each version's rules are distinguishable.
    const v1: WorkflowDefinition = {
      name: "pinned-order",
      initialState: "new",
      states: {
        new: { events: { Submit: { targetState: "review" } } },
        review: { events: { Approve: { targetState: "approved", commands: [{ name: "notify" }] } } },
        approved: {},
      },
    };
    const v2: WorkflowDefinition = {
      name: "pinned-order",
      version: 2,
      initialState: "new",
      states: {
        new: { events: { Submit: { targetState: "checking" } } },
        checking: { events: { Approve: { targetState: "accepted", commands: [{ name: "notify" }] } } },
        accepted: {},
      },
    };

    function buildRuntime(definition: WorkflowDefinition): WorkflowRuntime {
      const definitionRegistry = new InMemoryDefinitionRegistry({
        validator: new WorkflowValidator(),
        compiler: new WorkflowCompiler(),
      });
      definitionRegistry.register(definition);
      const commandRegistry = new InMemoryCommandRegistry();
      commandRegistry.register("notify", { execute: async () => ({ ok: true }) });
      return new WorkflowRuntime({
        definitionRegistry,
        commandRegistry,
        ...pgWorkflowProviders(pool),
        clock: { now: () => new Date() },
      });
    }

    afterEach(async () => {
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
      await pool.query("TRUNCATE workflow_definitions");
    });

    it("runs an in-flight instance on its v1 snapshot after v2 is deployed", async () => {
      const runtimeV1 = buildRuntime(v1);
      const instance = await runtimeV1.createInstance({ workflowName: "pinned-order" });
      await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

      const runtimeV2 = buildRuntime(v2);
      await runtimeV2.initialize();
      expect(await runtimeV2.getAvailableEvents({ workflowInstanceUuid: instance.uuid })).toEqual([
        expect.objectContaining({ eventName: "Approve", targetState: "approved" }),
      ]);
      const result = await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Approve" });

      expect(result.toState).toBe("approved");
      const stored = (await runtimeV2.getInstance(instance.uuid))!;
      expect([stored.currentState, stored.definitionVersion]).toEqual(["approved", 1]);
      expect((await runtimeV2.getHistory(instance.uuid))[0].definitionVersion).toBe(1);

      const fresh = await runtimeV2.createInstance({ workflowName: "pinned-order" });
      await runtimeV2.triggerEvent({ workflowInstanceUuid: fresh.uuid, eventName: "Submit" });
      expect((await runtimeV2.getInstance(fresh.uuid))!.currentState).toBe("checking");

      // v1's only instance rests in the terminal "approved" state.
      const versions = await runtimeV2.listDefinitionVersions("pinned-order");
      expect(versions.map((v) => [v.version, v.activeInstances])).toEqual([
        [1, 0],
        [2, 1],
      ]);
    });
  });

  describe("pg transaction sharing", () => {
    // A dedicated pool whose every connection has `lock_timeout` set, so a
    // regression that makes a call wait on a row lock held by its own caller's
    // transaction fails within seconds instead of hanging the suite. It shares
    // the throwaway duraflows_pg_it schema with the rest of the file.
    const sharingPool = new Pool({
      connectionString: databaseUrl,
      options: "-c search_path=duraflows_pg_it -c lock_timeout=2000",
    });
    const events: string[] = [];
    const observerErrors: string[] = [];

    /**
     * `a --next--> b --next--> c`. With `relay`, an observer entering `b`
     * triggers `next` on the same instance, so reaching `c` needs a duraflows
     * call made from inside an observer.
     */
    function buildRuntime({ relay }: { relay: boolean }): WorkflowRuntime {
      const definitionRegistry = new InMemoryDefinitionRegistry({
        validator: new WorkflowValidator(),
        compiler: new WorkflowCompiler(),
      });
      definitionRegistry.register({
        name: "relay",
        initialState: "a",
        states: { a: { events: { next: { targetState: "b" } } }, b: { events: { next: { targetState: "c" } } }, c: {} },
      });
      const runtime = new WorkflowRuntime({
        definitionRegistry,
        commandRegistry: new InMemoryCommandRegistry(),
        clock: { now: () => new Date() },
        ...pgWorkflowProviders(sharingPool, { lockTimeoutMs: 2000 }),
        onObserverError: (error) => void observerErrors.push(error instanceof Error ? error.message : String(error)),
      });
      runtime.addObserver({
        name: "relayer",
        onEnter: async (event) => {
          events.push(event.toState);
          if (relay && event.toState === "b") {
            await runtime.triggerEvent({ workflowInstanceUuid: event.instanceUuid, eventName: "next" });
          }
        },
      });
      return runtime;
    }

    async function stateOf(runtime: WorkflowRuntime, uuid: string): Promise<string> {
      return (await runtime.getInstance(uuid))!.currentState;
    }

    afterEach(async () => {
      events.length = 0;
      observerErrors.length = 0;
      await pool.query("TRUNCATE workflow_history, workflow_instances CASCADE");
    });

    afterAll(async () => {
      await sharingPool.end();
    });

    it("an observer of a bare-seeded call joins the caller's still-open transaction", { timeout: 15_000 }, async () => {
      const runtime = buildRuntime({ relay: true });
      const instance = await runtime.createInstance({ workflowName: "relay" });
      events.length = 0;

      const client = await sharingPool.connect();
      try {
        await client.query("BEGIN");
        await PgTransactionContext.run(sharingPool, client, () =>
          runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" }),
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      expect(observerErrors).toEqual([]);
      expect(events).toEqual(["b", "c"]);
      expect(await stateOf(runtime, instance.uuid)).toBe("c");
    });

    it("a helper transaction inside another joins it on the same instance", { timeout: 15_000 }, async () => {
      const runtime = buildRuntime({ relay: false });
      const instance = await runtime.createInstance({ workflowName: "relay" });
      events.length = 0;

      await PgTransactionContext.transaction(sharingPool, async (outer) => {
        await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });
        await PgTransactionContext.transaction(sharingPool, async (inner) => {
          expect(inner).toBe(outer);
          await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });
        });
        expect(events).toEqual([]);
      });

      expect(events).toEqual(["b", "c"]);
      expect(await stateOf(runtime, instance.uuid)).toBe("c");
    });

    it("an outer helper failure rolls back the inner helper's writes", { timeout: 15_000 }, async () => {
      const runtime = buildRuntime({ relay: false });
      const instance = await runtime.createInstance({ workflowName: "relay" });
      events.length = 0;

      await expect(
        PgTransactionContext.transaction(sharingPool, async () => {
          await PgTransactionContext.transaction(sharingPool, async () => {
            await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });
          });
          throw new Error("outer failure");
        }),
      ).rejects.toThrow("outer failure");

      expect(events).toEqual([]);
      expect(await stateOf(runtime, instance.uuid)).toBe("a");
    });

    it("a swallowed SQL error makes the helper reject instead of firing observers", { timeout: 15_000 }, async () => {
      const runtime = buildRuntime({ relay: false });
      const instance = await runtime.createInstance({ workflowName: "relay" });
      events.length = 0;

      const outcome = PgTransactionContext.transaction(sharingPool, async (client) => {
        await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });
        try {
          await client.query("SELECT 1/0");
        } catch {
          // swallowed on purpose: PostgreSQL now answers COMMIT with ROLLBACK
        }
      });

      await expect(outcome).rejects.toThrow(WorkflowError);
      await expect(outcome).rejects.toThrow(
        "COMMIT was rolled back by PostgreSQL because an earlier statement in the transaction failed",
      );
      expect(events).toEqual([]);
      expect(await stateOf(runtime, instance.uuid)).toBe("a");
    });
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
