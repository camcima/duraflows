import { describe, it, expect, vi } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  type WorkflowPersistenceProvider,
  type WorkflowCommand,
} from "../../src/index.js";

/** Real multi-connection tests shared by the two PostgreSQL adapters. */
export function runDatabaseDurableCases(label: string, providers: () => WorkflowPersistenceProvider): void {
  describe(`${label} durable executions`, () => {
    function fixture(transactional = false, suffix = "", bestEffort = false) {
      const p = providers();
      const name = (transactional ? "durable-db-transactional" : "durable-db") + suffix;
      let definitions = new InMemoryDefinitionRegistry();
      definitions.register({
        name,
        initialState: "new",
        states: {
          new: {
            events: {
              expire: { targetState: "done", timeout: { afterMinutes: 1 } },
              go: {
                targetState: "done",
                commands: [
                  { name: "first", transactional },
                  { name: "second", transactional },
                ],
              },
            },
          },
          done: {},
        },
      });
      const commands = new InMemoryCommandRegistry();
      let firstCalls = 0,
        secondCalls = 0;
      let first: WorkflowCommand["execute"] = () => ({ ok: true });
      let second: WorkflowCommand["execute"] = () => ({ ok: true });
      commands.register("first", {
        bestEffort,
        execute: (s, c) => {
          firstCalls++;
          return first(s, c);
        },
      });
      commands.register("second", {
        execute: (s, c) => {
          secondCalls++;
          return second(s, c);
        },
      });
      let now = Date.now();
      const make = () =>
        new WorkflowRuntime({
          ...p,
          definitionRegistry: definitions,
          commandRegistry: commands,
          clock: { now: () => new Date(now) },
          durableExecution: { leaseDurationMs: 100, initialDelayMs: 1 },
        });
      return {
        p,
        name,
        replaceDefinition: (definition: import("../../src/index.js").WorkflowDefinition) => {
          definitions = new InMemoryDefinitionRegistry();
          definitions.register(definition);
        },
        make,
        first: (fn: WorkflowCommand["execute"]) => {
          first = fn;
        },
        second: (fn: WorkflowCommand["execute"]) => {
          second = fn;
        },
        advance: (ms = 101) => {
          now += ms;
        },
        calls: () => [firstCalls, secondCalls],
      };
    }
    it("deduplicates concurrent acceptance and resumes persisted progress across runtimes", async () => {
      const f = fixture();
      const a = f.make(),
        b = f.make();
      const instance = await a.createInstance({ workflowName: f.name });
      const input = { workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "request" };
      const [x, y] = await Promise.all([a.enqueueEvent(input), b.enqueueEvent(input)]);
      expect(x.uuid).toBe(y.uuid);
      await a.processPendingExecutions();
      expect(f.calls()).toEqual([1, 0]);
      expect((await b.processPendingExecutions()).completed).toContain(x.uuid);
      expect(f.calls()).toEqual([1, 1]);
      expect((await b.getExecution(x.uuid))!.journal).toHaveLength(2);
      expect((await b.getInstance(instance.uuid))!.currentState).toBe("done");
      expect(await b.enqueueEvent(input)).toMatchObject({ uuid: x.uuid, status: "completed" });
    });
    it("fences an expired worker while preserving downstream command identity", async () => {
      const f = fixture();
      const a = f.make(),
        b = f.make();
      const instance = await a.createInstance({ workflowName: f.name });
      const e = await a.enqueueEvent({ workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "race" });
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const keys: string[] = [];
      f.first(async (_s, c) => {
        keys.push(c.durable!.idempotencyKey);
        if (keys.length === 1) {
          entered();
          await blocked;
        }
        c.context.owner = keys.length;
        return { ok: true };
      });
      const stale = a.processPendingExecutions();
      try {
        await started;
        expect((await b.processPendingExecutions()).processed).toBe(0);
        f.advance();
        expect((await b.processPendingExecutions()).progressed).toContain(e.uuid);
      } finally {
        release();
      }
      expect((await stale).skipped).toContain(e.uuid);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect((await b.getExecution(e.uuid))!.journal).toHaveLength(1);
      await b.processPendingExecutions();
      expect(f.calls()).toEqual([2, 1]);
    });
    it("commits short database commands with checkpoints and rolls back only the failing command", async () => {
      const f = fixture(true);
      const a = f.make();
      const business = await a.createInstance({ workflowName: f.name });
      const instance = await a.createInstance({ workflowName: f.name });
      const write = async (value: string) => {
        const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
        row.context.value = value;
        row.version++;
        await f.p.instanceStore.update(row);
      };
      f.first(async (_s, c) => {
        expect(f.p.transactionRunner.isTransactionActive!()).toBe(true);
        await write("first");
        await c.durable!.heartbeat();
        return { ok: true };
      });
      f.second(async () => {
        await write("second");
        throw new Error("second failed");
      });
      const e = await a.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "database",
      });
      await a.processPendingExecutions();
      expect((await a.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      expect((await a.processPendingExecutions()).retrying).toContain(e.uuid);
      expect((await a.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      expect((await a.getExecution(e.uuid))!.journal).toHaveLength(1);
      f.second(() => ({ ok: true }));
      f.advance();
      await a.processPendingExecutions();
      expect(f.calls()).toEqual([1, 2]);
    });
    it("enforces revision, key and active-instance uniqueness and rolls back acceptance", async () => {
      const f = fixture();
      const a = f.make();
      const instance = await a.createInstance({ workflowName: f.name });
      const input = { workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "unique" };
      await expect(
        f.p.transactionRunner.runInTransaction(async () => {
          await a.enqueueEvent(input);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await f.p.executionStore!.findByKey(instance.uuid, "unique")).toBeNull();
      const e = await a.enqueueEvent(input);
      for (const operation of [
        () => f.p.executionStore!.create({ ...e, uuid: crypto.randomUUID() }),
        () => f.p.executionStore!.create({ ...e, uuid: crypto.randomUUID(), idempotencyKey: "different" }),
        () => f.p.executionStore!.update({ ...e, revision: 99 }),
      ]) {
        await expect(
          f.p.transactionRunner.runInTransaction(async () => {
            await f.p.instanceStore.lockByUuid(instance.uuid);
            await operation();
          }),
        ).rejects.toThrow();
      }
      expect((await a.getExecution(e.uuid))!.revision).toBe(0);
      await a.cancelExecution(e.uuid);
      expect(await f.p.executionStore!.findActive(instance.uuid)).toBeNull();
      expect(await f.p.executionStore!.findByUuid(crypto.randomUUID())).toBeNull();
    });
    it("excludes occupied instances before limiting timeout candidates", async () => {
      const f = fixture();
      f.advance(-86400000);
      const runtime = f.make();
      const occupied = await runtime.createInstance({ workflowName: f.name });
      const queued = await runtime.enqueueEvent({
        workflowInstanceUuid: occupied.uuid,
        eventName: "go",
        idempotencyKey: "busy",
      });
      f.advance(1);
      const idle = await runtime.createInstance({ workflowName: f.name });
      f.advance(60001);
      expect((await runtime.processExpiredWorkflows({ limit: 1 })).processed).toBe(1);
      expect((await runtime.getInstance(idle.uuid))!.currentState).toBe("done");
      expect((await runtime.getInstance(occupied.uuid))!.currentState).toBe("new");
      await runtime.cancelExecution(queued.uuid);
    });

    it("rolls back successful database writes when checkpoint storage or finalization fails", async () => {
      const f = fixture(true);
      const runtime = f.make();
      const business = await runtime.createInstance({ workflowName: f.name });
      const instance = await runtime.createInstance({ workflowName: f.name });
      const write = async (value: string) => {
        const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
        row.context.value = value;
        row.version++;
        await f.p.instanceStore.update(row);
        return { ok: true };
      };
      f.first(() => write("first"));
      f.second(() => write("second"));
      const e = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "checkpoint-failure",
      });
      const store = f.p.executionStore!;
      const update = store.update.bind(store);
      let fail = true;
      const checkpoint = vi.spyOn(store, "update").mockImplementation(async (execution) => {
        await update(execution);
        if (fail && execution.journal.length === 1) {
          fail = false;
          throw new Error("checkpoint storage failed");
        }
      });
      try {
        expect((await runtime.processPendingExecutions()).retrying).toContain(e.uuid);
      } finally {
        checkpoint.mockRestore();
      }
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({});
      expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(0);
      f.advance();
      await runtime.processPendingExecutions();
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      const append = f.p.historyStore.append.bind(f.p.historyStore);
      const history = vi.spyOn(f.p.historyStore, "append").mockImplementationOnce(async (record) => {
        await append(record);
        throw new Error("finalization storage failed");
      });
      try {
        expect((await runtime.processPendingExecutions()).retrying).toContain(e.uuid);
      } finally {
        history.mockRestore();
      }
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ value: "first" });
      expect((await runtime.getInstance(instance.uuid))!.currentState).toBe("new");
      expect(await runtime.getHistory(instance.uuid)).toHaveLength(0);
      expect((await runtime.getExecution(e.uuid))!.journal).toHaveLength(1);
      f.advance();
      expect((await runtime.processPendingExecutions()).completed).toContain(e.uuid);
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ value: "second" });
      expect(f.calls()).toEqual([2, 2]);
    });

    it("commits transactional writes with a recorded business failure", async () => {
      const f = fixture(true);
      const runtime = f.make();
      const business = await runtime.createInstance({ workflowName: f.name });
      const instance = await runtime.createInstance({ workflowName: f.name });
      f.first(async () => {
        const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
        row.context.failureRecorded = true;
        row.version++;
        await f.p.instanceStore.update(row);
        return { ok: false, code: "DECLINED" };
      });
      const e = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "declined",
      });
      expect((await runtime.processPendingExecutions()).parked).toContain(e.uuid);
      expect((await runtime.getInstance(business.uuid))!.context).toEqual({ failureRecorded: true });
      expect((await runtime.getExecution(e.uuid))!.journal[0].result).toEqual({ ok: false, code: "DECLINED" });
      await runtime.cancelExecution(e.uuid);
    });
    it.each([false, true])(
      "persists safe retry and parked diagnostics with transactional=%s",
      async (transactional) => {
        const f = fixture(transactional, "-unicode");
        const runtime = f.make();
        const business = await runtime.createInstance({ workflowName: f.name });
        const instance = await runtime.createInstance({ workflowName: f.name });
        f.first(async () => {
          if (transactional) {
            const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
            row.context.changed = true;
            row.version++;
            await f.p.instanceStore.update(row);
          }
          return { ok: true };
        });
        f.second(async () => {
          if (transactional) {
            const row = (await f.p.instanceStore.lockByUuid(business.uuid))!;
            row.context.changed = false;
            row.version++;
            await f.p.instanceStore.update(row);
          }
          throw new Error("bad\u0000\ud800\udc00\ud800\udc00\udc00");
        });
        const e = await runtime.enqueueEvent({
          workflowInstanceUuid: instance.uuid,
          eventName: "go",
          idempotencyKey: "unicode",
        });
        await runtime.processPendingExecutions();
        for (let attempt = 1; attempt <= 10; attempt++) {
          const batch = await runtime.processPendingExecutions();
          expect(batch.failed).toEqual([]);
          expect(batch[attempt === 10 ? "parked" : "retrying"]).toContain(e.uuid);
          const current = (await runtime.getExecution(e.uuid))!;
          expect(current.lastError).toBe("bad�𐀀𐀀�");
          expect(current.leaseToken).toBeNull();
          expect(current.leaseUntil).toBeNull();
          expect(current.journal).toHaveLength(1);
          if (transactional) expect((await runtime.getInstance(business.uuid))!.context).toEqual({ changed: true });
          f.advance(4000000);
        }
        await runtime.cancelExecution(e.uuid);
      },
    );

    it("checkpoints best-effort thrown diagnostics and finalizes history", async () => {
      const f = fixture(false, "-best-effort-unicode", true);
      const runtime = f.make();
      const instance = await runtime.createInstance({ workflowName: f.name });
      f.first(() => {
        throw "bad\u0000\ud800";
      });
      const e = await runtime.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "best-effort",
      });
      expect((await runtime.processPendingExecutions()).progressed).toContain(e.uuid);
      expect((await runtime.processPendingExecutions()).completed).toContain(e.uuid);
      expect((await runtime.getExecution(e.uuid))!.journal[0].result).toMatchObject({
        ok: false,
        code: "BEST_EFFORT_THROWN",
        message: "bad��",
      });
      expect((await runtime.getHistory(instance.uuid))[0].commandResultsJson[0].message).toBe("bad��");
    });

    it("counts captured versions across transaction boundaries without double-counting", async () => {
      const f = fixture(false, "-usage");
      const v1 = f.make();
      const instance = await v1.createInstance({ workflowName: f.name });
      const original = await v1.enqueueEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
        idempotencyKey: "original",
      });
      // Definition v1 omits its version and must still count once, not twice.
      expect((await v1.listDefinitionVersions(f.name))[0].activeInstances).toBe(1);
      await v1.cancelExecution(original.uuid);
      const unrelated = fixture(false, "-unrelated-usage");
      const other = unrelated.make();
      const otherInstance = await other.createInstance({ workflowName: unrelated.name });
      const otherExecution = await other.enqueueEvent({
        workflowInstanceUuid: otherInstance.uuid,
        eventName: "go",
        idempotencyKey: "other",
      });
      expect((await v1.listDefinitionVersions(f.name))[0].activeInstances).toBe(1);
      await other.cancelExecution(otherExecution.uuid);
      const v2Definition = {
        name: f.name,
        version: 2,
        versionPolicy: "latest" as const,
        initialState: "new",
        states: {
          new: { events: { go: { targetState: "done", commands: [{ name: "first" }, { name: "second" }] } } },
          done: {},
        },
      };
      f.replaceDefinition(v2Definition);
      const v2 = f.make();
      await v2.initialize();
      const count = async (runtime = v2) =>
        (await runtime.listDefinitionVersions(f.name)).map((v) => v.activeInstances);
      expect(await count()).toEqual([1, 0]);
      const input = { workflowInstanceUuid: instance.uuid, eventName: "go", idempotencyKey: "queued" };
      await expect(
        f.p.transactionRunner.runInTransaction(async () => {
          await v2.enqueueEvent(input);
          expect(await count()).toEqual([1, 1]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await count()).toEqual([1, 0]);
      const e = await v2.enqueueEvent(input);
      expect(await count()).toEqual([1, 1]);
      expect(
        await f.p.executionStore!.countInstancesUsingDefinition!({
          workflowName: f.name,
          definitionVersion: 2,
          excludeStates: ["new"],
        }),
      ).toBe(1);
      f.first(async () => {
        expect(await count()).toEqual([1, 1]);
        return { ok: true };
      });
      await v2.processPendingExecutions();
      const recovered = f.make();
      expect((await recovered.processPendingExecutions()).completed).toContain(e.uuid);
      expect(await count(recovered)).toEqual([0, 0]);
      const another = await recovered.createInstance({ workflowName: f.name });
      const parked = await recovered.enqueueEvent({
        ...input,
        workflowInstanceUuid: another.uuid,
        idempotencyKey: "parked",
      });
      expect(await count()).toEqual([0, 1]);
      f.first(() => ({ ok: false }));
      await recovered.processPendingExecutions();
      expect((await recovered.getExecution(parked.uuid))!.status).toBe("parked");
      expect(await count()).toEqual([0, 1]);
      await recovered.cancelExecution(parked.uuid);
      // The stamped nonterminal instance still requires v2.
      expect(await count()).toEqual([0, 1]);
    });
  });
}
