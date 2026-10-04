import { describe, it, expect, vi } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  IdempotencyInProgressError,
} from "../../src/index.js";
import type { WorkflowPersistenceProvider, CommandResult } from "../../src/index.js";
import { runIdempotencyStoreConformance } from "../../src/testing/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Run only against a real database with a connection pool, never against the in-memory double. */
export function runDatabaseIdempotencyCases(label: string, providers: () => WorkflowPersistenceProvider): void {
  function build(p = providers()) {
    const definitions = new InMemoryDefinitionRegistry();
    definitions.register({
      name: "database-idempotency",
      initialState: "new",
      states: {
        new: {
          events: {
            submit: { targetState: "done", commands: [{ name: "work" }] },
            note: { commands: [{ name: "work" }] },
          },
        },
        done: {},
      },
    });
    const commands = new InMemoryCommandRegistry();
    const work = vi.fn(async (): Promise<CommandResult> => ({ ok: true }));
    commands.register("work", { execute: work });
    const observe = vi.fn();
    const runtime = new WorkflowRuntime({
      ...p,
      definitionRegistry: definitions,
      commandRegistry: commands,
      clock: { now: () => new Date() },
      observers: [{ name: "observe", onEnter: observe }],
    });
    return { p, runtime, work, observe };
  }

  runIdempotencyStoreConformance(`${label} (real PostgreSQL)`, {
    setup: async () => {
      const { p, runtime } = build();
      const uuid = (await runtime.createInstance({ workflowName: "database-idempotency" })).uuid;
      return {
        store: p.idempotencyStore!,
        transactionRunner: p.transactionRunner,
        instanceUuid: uuid,
        withInstanceLock: (work) =>
          p.transactionRunner.runInTransaction(async () => {
            await p.instanceStore.lockByUuid(uuid);
            return work();
          }),
        teardown: async () => {}, // The enclosing suite drops its dedicated schema.
      };
    },
  });

  describe(`${label} concurrent keyed events`, () => {
    it.each([false, true])("serializes duplicate requests when the first rolls back=%s", async (rollback) => {
      const { p, runtime, work, observe } = build();
      const uuid = (await runtime.createInstance({ workflowName: "database-idempotency" })).uuid;
      observe.mockClear();
      const started = deferred();
      const release = deferred();
      const secondLock = deferred();
      work.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        if (rollback) throw new Error("first execution rolled back");
        return { ok: true };
      });
      const lock = p.instanceStore.lockByUuid.bind(p.instanceStore);
      let calls = 0;
      vi.spyOn(p.instanceStore, "lockByUuid").mockImplementation(async (id) => {
        if (++calls === 2) secondLock.resolve();
        return lock(id);
      });
      const input = { workflowInstanceUuid: uuid, eventName: "submit", idempotencyKey: "provider-event" };
      const first = runtime.triggerEvent(input);
      // Attach both rejection handlers before releasing the first request.
      const firstSettled = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let secondSettled: Promise<unknown> | undefined;
      try {
        await started.promise;
        const second = runtime.triggerEvent(input);
        secondSettled = second.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await secondLock.promise;
        release.resolve();
        const a = await firstSettled;
        const b = await secondSettled;
        if (rollback) expect(a).toMatchObject({ error: expect.any(Error) });
        else expect(b).toEqual(a);
        expect(b).toMatchObject({ value: { outcome: "success", toState: "done" } });
        expect(work).toHaveBeenCalledTimes(rollback ? 2 : 1);
        expect(await runtime.getHistory(uuid)).toHaveLength(1);
        expect(observe).toHaveBeenCalledOnce();
        await p.transactionRunner.runInTransaction(async () => {
          expect((await p.idempotencyStore!.find(uuid, input.idempotencyKey))!.result).toMatchObject({
            outcome: "success",
          });
        });
      } finally {
        release.resolve();
        await firstSettled;
        await secondSettled;
      }
    });

    it("rolls back completed keyed calls with an outer transaction", async () => {
      const { p, runtime, work, observe } = build();
      const uuid = (await runtime.createInstance({ workflowName: "database-idempotency" })).uuid;
      observe.mockClear();
      const input = { workflowInstanceUuid: uuid, eventName: "submit", idempotencyKey: "outer" };
      await expect(
        p.transactionRunner.runInTransaction(async () => {
          await runtime.triggerEvent(input);
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");
      expect(observe).not.toHaveBeenCalled();
      expect(await runtime.getHistory(uuid)).toHaveLength(0);
      expect((await runtime.triggerEvent(input)).outcome).toBe("success");
      expect(work).toHaveBeenCalledTimes(2);
    });

    it("detects recursion through another runtime on the same database transaction", async () => {
      const a = build();
      const b = build();
      const uuid = (await a.runtime.createInstance({ workflowName: "database-idempotency" })).uuid;
      const input = { workflowInstanceUuid: uuid, eventName: "note", idempotencyKey: "recursive" };
      a.work.mockImplementationOnce(async () => {
        await expect(b.runtime.triggerEvent(input)).rejects.toThrow(IdempotencyInProgressError);
        return { ok: true };
      });
      await a.runtime.triggerEvent(input);
      expect(b.work).not.toHaveBeenCalled();
    });

    it("scopes identical keys to different instances and normalizes JSON results", async () => {
      const { runtime, work } = build();
      work.mockResolvedValue({ ok: true, metadata: { at: new Date("2026-10-03") } });
      for (let i = 0; i < 2; i++) {
        const uuid = (await runtime.createInstance({ workflowName: "database-idempotency" })).uuid;
        const input = { workflowInstanceUuid: uuid, eventName: "note", idempotencyKey: "same" };
        const first = await runtime.triggerEvent(input);
        expect(await runtime.triggerEvent(input)).toEqual(first);
        expect(first.commandResults[0].metadata!.at).toBe("2026-10-03T00:00:00.000Z");
      }
      expect(work).toHaveBeenCalledTimes(2);
    });
  });
}
