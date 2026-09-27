import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import {
  runInstanceStoreConformance,
  runDefinitionStoreConformance,
  runTransactionRunnerConformance,
} from "@duraflows/core/testing";
import {
  type WorkflowInstance,
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  WorkflowValidator,
  WorkflowCompiler,
} from "@duraflows/core";
import { generateMigrationSql } from "@duraflows/pg";
import {
  KyselyWorkflowInstanceStore,
  KyselyWorkflowHistoryStore,
  KyselyWorkflowDefinitionStore,
  KyselyTransactionRunner,
  KyselyTransactionContext,
  kyselyWorkflowProviders,
  kyselyWorkflowProvidersFromTransaction,
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
  const definitionStore = new KyselyWorkflowDefinitionStore(db);

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
    // Bootstrap the dedicated schema on a single pg client. `generateMigrationSql`
    // returns a multi-statement string, which Kysely's `sql.execute()` cannot run
    // (the wire protocol returns one result set), so a raw client is used here.
    // The pool's `search_path` startup option (kysely_it) already points every
    // connection at this schema; CREATE SCHEMA below is unqualified-DDL-safe.
    const client = await pool.connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS kysely_it");
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

  runDefinitionStoreConformance("kysely (real PostgreSQL)", {
    setup: async () => ({
      store: definitionStore,
      teardown: async () => {
        await sql`TRUNCATE workflow_definitions`.execute(db);
      },
    }),
  });

  runTransactionRunnerConformance("kysely (real PostgreSQL)", {
    setup: async () => ({
      runner: transactionRunner,
      store: instanceStore,
      failWithDatabaseError: async () => {
        await sql`SELECT 1/0`.execute(KyselyTransactionContext.getTransaction(db)!);
      },
      teardown: async () => {
        await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
      },
    }),
  });

  describe("kysely runtime inside an outer transaction", () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    let now = start;
    const observed: string[] = [];

    function registries() {
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
            events: {
              go: { targetState: "done" },
              explode: { targetState: "mid" },
              expire: { targetState: "mid", timeout: { afterMinutes: 1 } },
            },
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
      return { definitionRegistry, commandRegistry };
    }

    function buildRuntime(persistence = kyselyWorkflowProviders(db)): WorkflowRuntime {
      return new WorkflowRuntime({
        ...registries(),
        ...persistence,
        clock: { now: () => new Date(now) },
        observers: [{ name: "recorder", onEnter: (event) => void observed.push(event.toState) }],
      });
    }

    afterEach(async () => {
      observed.length = 0;
      now = start;
      await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
      await sql`TRUNCATE workflow_definitions`.execute(db);
    });

    it("fires no observer when the outer transaction rolls back", async () => {
      const runtime = buildRuntime();
      const instance = await runtime.createInstance({ workflowName: "flow" });
      observed.length = 0;

      await expect(
        KyselyTransactionContext.transaction(db, async () => {
          await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");

      expect(observed).toEqual([]);
      expect((await runtime.getInstance(instance.uuid))!.currentState).toBe("start");
    });

    it("fires the observer once, after COMMIT, through KyselyTransactionContext.transaction", async () => {
      const runtime = buildRuntime();
      const instance = await runtime.createInstance({ workflowName: "flow" });
      observed.length = 0;

      await KyselyTransactionContext.transaction(db, async () => {
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
      expect((await runtime.getInstance(instance.uuid))!.currentState).toBe("start");
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

    it("kyselyWorkflowProvidersFromTransaction leaves no partial writes from a caught failure", async () => {
      const setupRuntime = buildRuntime();
      const instance = await setupRuntime.createInstance({ workflowName: "flow" });

      await db.transaction().execute(async (trx) => {
        const runtime = buildRuntime(kyselyWorkflowProvidersFromTransaction(trx));
        await expect(
          runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "explode" }),
        ).rejects.toThrow("js boom");
      });

      expect((await setupRuntime.getInstance(instance.uuid))!.currentState).toBe("start");
    });
  });

  describe("kysely transaction sharing", () => {
    // A dedicated pool whose every connection has `lock_timeout` set, so a
    // regression that makes a call wait on a row lock held by its own caller's
    // transaction fails within seconds instead of hanging the suite. It shares
    // the throwaway kysely_it schema with the rest of the file.
    const sharingDb = new Kysely<WorkflowDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: databaseUrl, options: "-c search_path=kysely_it -c lock_timeout=2000" }),
      }),
    });
    const events: string[] = [];
    const observerErrors: string[] = [];

    /**
     * `a --next--> b --next--> c`. With `relay`, an observer entering `b`
     * triggers `next` on the same instance, so reaching `c` needs a duraflows
     * call made from inside an observer.
     */
    function buildRuntime(
      { relay }: { relay: boolean },
      persistence = kyselyWorkflowProviders(sharingDb, { lockTimeoutMs: 2000 }),
    ): WorkflowRuntime {
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
        ...persistence,
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
      await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
    });

    afterAll(async () => {
      await sharingDb.destroy();
    });

    it("an observer of a bare-seeded call joins the caller's still-open transaction", { timeout: 15_000 }, async () => {
      const runtime = buildRuntime({ relay: true });
      const instance = await runtime.createInstance({ workflowName: "relay" });
      events.length = 0;

      await sharingDb
        .transaction()
        .execute((trx) =>
          KyselyTransactionContext.run(sharingDb, trx, () =>
            runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" }),
          ),
        );

      expect(observerErrors).toEqual([]);
      expect(events).toEqual(["b", "c"]);
      expect(await stateOf(runtime, instance.uuid)).toBe("c");
    });

    it(
      "an observer of a kyselyWorkflowProvidersFromTransaction call joins the caller's transaction",
      { timeout: 15_000 },
      async () => {
        const setupRuntime = buildRuntime({ relay: false });
        const instance = await setupRuntime.createInstance({ workflowName: "relay" });
        events.length = 0;

        await sharingDb.transaction().execute(async (trx) => {
          const runtime = buildRuntime({ relay: true }, kyselyWorkflowProvidersFromTransaction(trx));
          await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });
        });

        expect(observerErrors).toEqual([]);
        expect(events).toEqual(["b", "c"]);
        expect(await stateOf(setupRuntime, instance.uuid)).toBe("c");
      },
    );

    it("a helper transaction inside another joins it on the same instance", { timeout: 15_000 }, async () => {
      const runtime = buildRuntime({ relay: false });
      const instance = await runtime.createInstance({ workflowName: "relay" });
      events.length = 0;

      await KyselyTransactionContext.transaction(sharingDb, async (outer) => {
        await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });
        await KyselyTransactionContext.transaction(sharingDb, async (inner) => {
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
        KyselyTransactionContext.transaction(sharingDb, async () => {
          await KyselyTransactionContext.transaction(sharingDb, async () => {
            await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });
          });
          throw new Error("outer failure");
        }),
      ).rejects.toThrow("outer failure");

      expect(events).toEqual([]);
      expect(await stateOf(runtime, instance.uuid)).toBe("a");
    });
  });

  describe("kysely adapter integration", () => {
    // Cleanup runs in afterEach (not at the end of each test body) so a
    // failing assertion cannot leak rows into the next test.
    afterEach(async () => {
      await sql`TRUNCATE workflow_history, workflow_instances CASCADE`.execute(db);
      await sql`TRUNCATE workflow_definitions`.execute(db);
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
      await transactionRunner.runInTransaction(() =>
        historyStore.append({
          workflowInstanceUuid: instance.uuid,
          fromState: "a",
          eventName: "Go",
          toState: "b",
          outcome: "success",
          commandResultsJson: [],
          definitionVersion: 3,
        }),
      );
      const [record] = await historyStore.findByInstanceUuid(instance.uuid);
      expect(record.definitionVersion).toBe(3);
    });

    it("round-trips history createdAt as a Date assigned by the database", async () => {
      const instance = makeInstance();
      await transactionRunner.runInTransaction(() => instanceStore.create(instance));

      const before = Date.now();
      await transactionRunner.runInTransaction(() =>
        historyStore.append({
          workflowInstanceUuid: instance.uuid,
          fromState: "a",
          eventName: "Go",
          toState: "b",
          outcome: "success",
          commandResultsJson: [],
        }),
      );
      const after = Date.now();

      const [record] = await historyStore.findByInstanceUuid(instance.uuid);
      expect(record.createdAt).toBeInstanceOf(Date);
      // The database assigns created_at via `now()`, so it must fall within the
      // wall-clock window the append() call actually executed in.
      expect(record.createdAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(record.createdAt!.getTime()).toBeLessThanOrEqual(after + 1000);
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
