import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  runInstanceStoreConformance,
  runDefinitionStoreConformance,
  runTransactionRunnerConformance,
} from "@duraflows/core/testing";
import type { WorkflowInstance, WorkflowHistoryRecord } from "@duraflows/core";
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
