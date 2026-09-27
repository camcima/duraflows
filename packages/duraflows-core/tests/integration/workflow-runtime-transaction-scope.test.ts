import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { createInMemoryPersistence } from "../helpers/in-memory-persistence.js";
import type { WorkflowTransactionRunner } from "../../src/types/persistence.js";

describe("WorkflowRuntime inside an outer transaction", () => {
  let now = new Date("2026-01-01T00:00:00Z").getTime();
  const clock = { now: () => new Date(now) };
  let persistence: ReturnType<typeof createInMemoryPersistence>;
  let definitionRegistry: InMemoryDefinitionRegistry;
  let commandRegistry: InMemoryCommandRegistry;
  let observed: string[];

  function buildRuntime(transactionRunner: WorkflowTransactionRunner): WorkflowRuntime {
    return new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore: persistence.instanceStore,
      historyStore: persistence.historyStore,
      transactionRunner,
      clock,
      observers: [
        {
          name: "recorder",
          onEnter: (event) => {
            observed.push(`${event.workflowName}:${event.toState}`);
          },
        },
      ],
    });
  }

  beforeEach(() => {
    now = new Date("2026-01-01T00:00:00Z").getTime();
    observed = [];
    persistence = createInMemoryPersistence();
    definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    commandRegistry = new InMemoryCommandRegistry();
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
        start: {
          events: { expire: { targetState: "done", commands: [{ name: "note" }], timeout: { afterMinutes: 1 } } },
        },
        done: {},
      },
    });
    commandRegistry.register("boom", {
      execute: async () => {
        throw new Error("js boom");
      },
    });
    commandRegistry.register("note", {
      execute: async () => {
        observed.push("command:healthy");
        return { ok: true };
      },
    });
  });

  it("fires triggerEvent observers only after the outer transaction commits", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);
    const instance = await runtime.createInstance({ workflowName: "flow" });
    observed = [];

    await persistence.transactionRunner.runInTransaction(async () => {
      await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });
      expect(observed).toEqual([]);
    });

    expect(observed).toEqual(["flow:done"]);
  });

  it("fires no observers when the outer transaction rolls back", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);
    const instance = await runtime.createInstance({ workflowName: "flow" });
    observed = [];

    await expect(
      persistence.transactionRunner.runInTransaction(async () => {
        await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");

    expect(observed).toEqual([]);
    expect((await persistence.instanceStore.findByUuid(instance.uuid))!.currentState).toBe("start");
  });

  it("a caught nested triggerEvent failure leaves no partial writes behind", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);
    const instance = await runtime.createInstance({ workflowName: "flow" });
    const historyBefore = await runtime.getHistory(instance.uuid);

    await persistence.transactionRunner.runInTransaction(async () => {
      await expect(runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "explode" })).rejects.toThrow(
        "js boom",
      );
    });

    expect((await persistence.instanceStore.findByUuid(instance.uuid))!.currentState).toBe("start");
    expect(await runtime.getHistory(instance.uuid)).toHaveLength(historyBefore.length);
  });

  it("a nested sweep commits nothing for a failing instance and still commits a healthy one", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);
    const failing = await runtime.createInstance({ workflowName: "flow" });
    now += 1000;
    const healthy = await runtime.createInstance({ workflowName: "healthy" });
    const failingHistoryBefore = await runtime.getHistory(failing.uuid);
    observed = [];
    now += 5 * 60_000;

    const result = await persistence.transactionRunner.runInTransaction(async () => {
      const sweep = await runtime.processExpiredWorkflows();
      expect(observed).toEqual(["command:healthy"]);
      return sweep;
    });

    expect(result.failed.map((f) => f.uuid)).toEqual([failing.uuid]);
    expect(result.processed).toBe(1);
    expect((await persistence.instanceStore.findByUuid(failing.uuid))!.currentState).toBe("start");
    expect(await runtime.getHistory(failing.uuid)).toHaveLength(failingHistoryBefore.length);
    expect((await persistence.instanceStore.findByUuid(healthy.uuid))!.currentState).toBe("done");
    expect(observed).toEqual(["command:healthy", "healthy:done"]);
  });

  it("a nested sweep keeps a healthy instance's observers until the outer commit when a later instance fails", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);
    const healthy = await runtime.createInstance({ workflowName: "healthy" });
    now += 1000;
    const failing = await runtime.createInstance({ workflowName: "flow" });
    observed = [];
    now += 5 * 60_000;

    const result = await persistence.transactionRunner.runInTransaction(async () => {
      const sweep = await runtime.processExpiredWorkflows();
      // The healthy instance's savepoint was released before the failing
      // sibling's was rolled back; its observers must still be pending.
      expect(observed).toEqual(["command:healthy"]);
      return sweep;
    });

    expect(result.failed.map((f) => f.uuid)).toEqual([failing.uuid]);
    expect((await persistence.instanceStore.findByUuid(healthy.uuid))!.currentState).toBe("done");
    expect((await persistence.instanceStore.findByUuid(failing.uuid))!.currentState).toBe("start");
    expect(observed).toEqual(["command:healthy", "healthy:done"]);
  });

  it("defers createInstance observers until the outer transaction commits", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);

    await persistence.transactionRunner.runInTransaction(async () => {
      await runtime.createInstance({ workflowName: "flow" });
      expect(observed).toEqual([]);
    });

    expect(observed).toEqual(["flow:start"]);
  });

  it("fires no createInstance observer and keeps no instance when the outer transaction rolls back", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);
    let createdUuid = "";

    await expect(
      persistence.transactionRunner.runInTransaction(async () => {
        createdUuid = (await runtime.createInstance({ workflowName: "flow" })).uuid;
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");

    expect(observed).toEqual([]);
    expect(await persistence.instanceStore.findByUuid(createdUuid)).toBeNull();
  });

  it("a top-level sweep fires each instance's observers after that instance commits", async () => {
    definitionRegistry.register({
      name: "healthy2",
      initialState: "start",
      states: {
        start: {
          events: { expire: { targetState: "done", commands: [{ name: "note2" }], timeout: { afterMinutes: 1 } } },
        },
        done: {},
      },
    });
    commandRegistry.register("note2", {
      execute: async () => {
        observed.push("command:healthy2");
        return { ok: true };
      },
    });
    const runtime = buildRuntime(persistence.transactionRunner);
    await runtime.createInstance({ workflowName: "healthy" });
    now += 1000;
    await runtime.createInstance({ workflowName: "healthy2" });
    observed = [];
    now += 5 * 60_000;

    await runtime.processExpiredWorkflows();

    expect(observed).toEqual(["command:healthy", "healthy:done", "command:healthy2", "healthy2:done"]);
  });

  it("an observer can trigger another event: it runs in a fresh transaction and its observers fire", async () => {
    const runtime = buildRuntime(persistence.transactionRunner);
    definitionRegistry.register({
      name: "relay",
      initialState: "a",
      states: { a: { events: { next: { targetState: "b" } } }, b: { events: { next: { targetState: "c" } } }, c: {} },
    });
    const instance = await runtime.createInstance({ workflowName: "relay" });
    runtime.addObserver({
      name: "relayer",
      onEnter: async (event) => {
        if (event.workflowName === "relay" && event.toState === "b") {
          await runtime.triggerEvent({ workflowInstanceUuid: event.instanceUuid, eventName: "next" });
        }
      },
    });
    observed = [];

    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "next" });

    expect((await persistence.instanceStore.findByUuid(instance.uuid))!.currentState).toBe("c");
    expect(observed).toEqual(["relay:b", "relay:c"]);
  });

  it("a runner without afterCommit keeps firing when the runtime's own call returns", async () => {
    const inner = persistence.transactionRunner;
    const bareRunner: WorkflowTransactionRunner = {
      runInTransaction: (callback) => inner.runInTransaction(callback),
    };
    const runtime = buildRuntime(bareRunner);
    const instance = await runtime.createInstance({ workflowName: "flow" });
    observed = [];

    await inner.runInTransaction(async () => {
      await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });
      expect(observed).toEqual(["flow:done"]);
    });
  });
});
