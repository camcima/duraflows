import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import {
  createInMemoryPersistence,
  type InMemoryHistoryStore,
  type InMemoryInstanceStore,
  type InMemoryTransactionRunner,
} from "../helpers/in-memory-persistence.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { StateEnterEvent } from "../../src/types/observer.js";
import type { WorkflowClock } from "../../src/types/persistence.js";

describe("WorkflowRuntime observers", () => {
  const fixedDate = new Date("2026-04-23T12:00:00.000Z");
  const clock: WorkflowClock = { now: () => fixedDate };

  let runtime: WorkflowRuntime;
  let commandRegistry: InMemoryCommandRegistry;
  let instanceStore: InMemoryInstanceStore;
  let historyStore: InMemoryHistoryStore;
  let transactionRunner: InMemoryTransactionRunner;
  let definitionRegistry: InMemoryDefinitionRegistry;

  beforeEach(() => {
    definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    commandRegistry = new InMemoryCommandRegistry();
    ({ instanceStore, historyStore, transactionRunner } = createInMemoryPersistence());

    runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore,
      historyStore,
      transactionRunner,
      clock,
    });
  });

  it("fires onEnter on registered observer when triggerEvent transitions state", async () => {
    const definition: WorkflowDefinition = {
      name: "obs-event",
      initialState: "draft",
      states: {
        draft: { events: { submit: { targetState: "submitted" } } },
        submitted: {},
      },
    };
    definitionRegistry.register(definition);

    const captured: StateEnterEvent[] = [];
    runtime.addObserver({
      name: "capture",
      onEnter: (event) => {
        captured.push(event);
      },
    });

    const instance = await runtime.createInstance({ workflowName: "obs-event" });
    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      triggerMetadata: { actor: "tester" },
    });

    expect(captured).toHaveLength(2);

    expect(captured[0].state).toBe("draft");
    expect(captured[0].fromState).toBeNull();
    expect(captured[0].toState).toBe("draft");
    expect(captured[0].triggerEvent).toBeNull();
    expect(captured[0].workflowName).toBe("obs-event");

    expect(captured[1].state).toBe("submitted");
    expect(captured[1].fromState).toBe("draft");
    expect(captured[1].toState).toBe("submitted");
    expect(captured[1].triggerEvent).toBe("submit");
    expect(captured[1].triggerMetadata.actor).toBe("tester");
    expect(captured[1].transitionUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fires onEnter for each hop of an onEnter chain after triggerEvent", async () => {
    const definition: WorkflowDefinition = {
      name: "obs-chain",
      initialState: "draft",
      states: {
        draft: { events: { go: { targetState: "step1" } } },
        step1: { onEnter: { targetState: "step2" } },
        step2: { onEnter: { targetState: "step3" } },
        step3: {},
      },
    };
    definitionRegistry.register(definition);

    const captured: StateEnterEvent[] = [];
    runtime.addObserver({
      name: "chain-capture",
      onEnter: (event) => {
        captured.push(event);
      },
    });

    const instance = await runtime.createInstance({ workflowName: "obs-chain" });
    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });

    expect(captured.map((e) => e.state)).toEqual(["draft", "step1", "step2", "step3"]);
    expect(captured.map((e) => e.fromState)).toEqual([null, "draft", "step1", "step2"]);
    expect(captured.map((e) => e.triggerEvent)).toEqual([null, "go", "onEnter", "onEnter"]);

    const uuids = captured.map((e) => e.transitionUuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it("an observer that throws does not abort the transition or block other observers", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definition: WorkflowDefinition = {
      name: "obs-throws",
      initialState: "draft",
      states: {
        draft: { events: { submit: { targetState: "submitted" } } },
        submitted: {},
      },
    };
    definitionRegistry.register(definition);

    const followingCalls: number[] = [];
    runtime.addObserver({
      name: "thrower",
      onEnter: () => {
        throw new Error("observer broke");
      },
    });
    runtime.addObserver({
      name: "follower",
      onEnter: () => {
        followingCalls.push(Date.now());
      },
    });

    const instance = await runtime.createInstance({ workflowName: "obs-throws" });
    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
    });

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("submitted");
    expect(followingCalls).toHaveLength(2);
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    warnSpy.mockRestore();
  });

  it("supports observers passed via the constructor", async () => {
    const captured: StateEnterEvent[] = [];

    const constructorObserverRuntime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore,
      historyStore,
      transactionRunner,
      clock,
      observers: [
        {
          name: "ctor-observer",
          onEnter: (event) => {
            captured.push(event);
          },
        },
      ],
    });

    const definition: WorkflowDefinition = {
      name: "obs-ctor",
      initialState: "ready",
      states: { ready: {} },
    };
    definitionRegistry.register(definition);

    await constructorObserverRuntime.createInstance({ workflowName: "obs-ctor" });

    expect(captured).toHaveLength(1);
    expect(captured[0].state).toBe("ready");
  });

  it("observer snapshots do not freeze live instance.context nested objects", async () => {
    const definition: WorkflowDefinition = {
      name: "obs-snapshot-isolation",
      initialState: "draft",
      states: {
        draft: {
          events: {
            step1: {
              targetState: "middle",
              commands: [{ name: "setNested" }],
            },
          },
        },
        middle: {
          onEnter: {
            targetState: "done",
            commands: [{ name: "mutateNested" }],
          },
        },
        done: {},
      },
    };
    definitionRegistry.register(definition);

    commandRegistry.register("setNested", {
      execute: async (_subject, ctx) => {
        ctx.context["nested"] = { count: 1, deeper: { tag: "initial" } };
        return { ok: true };
      },
    });
    commandRegistry.register("mutateNested", {
      execute: async (_subject, ctx) => {
        const nested = ctx.context["nested"] as { count: number; deeper: { tag: string } };
        // With the fix: instance.context.nested is a fresh object (structuredClone), NOT frozen — these succeed.
        // Without the fix: deepFreeze({ ...instance.context }) aliased the nested refs and froze them in-place.
        // These mutations throw TypeError in that case, surfacing the bug inside a single triggerEvent call.
        nested.count = 2;
        nested.deeper.tag = "updated";
        return { ok: true };
      },
    });

    runtime.addObserver({
      name: "snapshot-reader",
      onEnter: () => {
        // Presence forces the runtime to build the snapshot (triggering deepFreeze).
      },
    });

    const instance = await runtime.createInstance({ workflowName: "obs-snapshot-isolation" });
    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "step1",
    });

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("done");

    const updated = await instanceStore.findByUuid(instance.uuid);
    const nested = updated!.context["nested"] as { count: number; deeper: { tag: string } };
    expect(nested.count).toBe(2);
    expect(nested.deeper.tag).toBe("updated");
  });

  it("observer event transitionUuid equals the one commands saw for the same state entry", async () => {
    const definition: WorkflowDefinition = {
      name: "obs-uuid-correlation",
      initialState: "draft",
      states: {
        draft: {
          events: {
            go: {
              targetState: "step1",
              commands: [{ name: "captureEventUuid" }],
            },
          },
        },
        step1: {
          onEnter: {
            targetState: "step2",
            commands: [{ name: "captureStep1Uuid" }],
          },
        },
        step2: {
          onEnter: {
            targetState: "done",
            commands: [{ name: "captureStep2Uuid" }],
          },
        },
        done: {},
      },
    };
    definitionRegistry.register(definition);

    const commandSeen: Record<string, string> = {};
    commandRegistry.register("captureEventUuid", {
      execute: async (_subject, ctx) => {
        commandSeen["event"] = ctx.transitionUuid;
        return { ok: true };
      },
    });
    commandRegistry.register("captureStep1Uuid", {
      execute: async (_subject, ctx) => {
        commandSeen["step1"] = ctx.transitionUuid;
        return { ok: true };
      },
    });
    commandRegistry.register("captureStep2Uuid", {
      execute: async (_subject, ctx) => {
        commandSeen["step2"] = ctx.transitionUuid;
        return { ok: true };
      },
    });

    const captured: StateEnterEvent[] = [];
    runtime.addObserver({
      name: "uuid-capture",
      onEnter: (event) => {
        captured.push(event);
      },
    });

    const instance = await runtime.createInstance({ workflowName: "obs-uuid-correlation" });
    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });

    // captured: createInstance(draft) + triggerEvent(step1) + onEnter(step2) + onEnter(done)
    expect(captured).toHaveLength(4);

    const enterStep1 = captured.find((e) => e.state === "step1")!;
    const enterStep2 = captured.find((e) => e.state === "step2")!;
    const enterDone = captured.find((e) => e.state === "done")!;

    // The event commands AND step1's onEnter commands BOTH fire "on entry to step1" —
    // they share the SAME UUID (the entry UUID for step1).
    expect(commandSeen["event"]).toBe(enterStep1.transitionUuid);
    expect(commandSeen["step1"]).toBe(enterStep1.transitionUuid);

    // step2's onEnter commands fire on entry to step2 → match enterStep2 UUID
    expect(commandSeen["step2"]).toBe(enterStep2.transitionUuid);

    // All entry UUIDs are distinct (each state entry is unique)
    const uuids = [enterStep1.transitionUuid, enterStep2.transitionUuid, enterDone.transitionUuid];
    expect(new Set(uuids).size).toBe(3);
  });

  it("caller-supplied triggerMetadata nested objects remain mutable after createInstance returns", async () => {
    // Use an onEnter definition so the runtime takes the onEnter branch in createInstance,
    // which is where the buggy deepFreeze({ ...(input.triggerMetadata ?? {}) }) lives.
    const definition: WorkflowDefinition = {
      name: "trigger-metadata-isolation",
      initialState: "ready",
      states: {
        ready: {
          onEnter: { targetState: "active" },
        },
        active: {},
      },
    };
    definitionRegistry.register(definition);

    const callerMetadata = { audit: { tag: "initial" } };
    await runtime.createInstance({
      workflowName: "trigger-metadata-isolation",
      triggerMetadata: callerMetadata,
    });

    // Without the fix: deepFreeze recursed into callerMetadata.audit and froze it.
    // The following mutation would throw TypeError in strict mode.
    expect(() => {
      callerMetadata.audit.tag = "updated";
    }).not.toThrow();
    expect(callerMetadata.audit.tag).toBe("updated");
    expect(Object.isFrozen(callerMetadata.audit)).toBe(false);
  });

  it("uses the runtime's onObserverError handler for thrown observer errors", async () => {
    const handler = vi.fn();

    const runtime2 = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore,
      historyStore,
      transactionRunner,
      clock,
      onObserverError: handler,
    });

    const definition: WorkflowDefinition = {
      name: "observer-error-handler",
      initialState: "ready",
      states: { ready: {} },
    };
    definitionRegistry.register(definition);

    runtime2.addObserver({
      name: "throwing",
      onEnter: () => {
        throw new Error("observer crashed");
      },
    });

    await runtime2.createInstance({ workflowName: "observer-error-handler" });

    expect(handler).toHaveBeenCalledTimes(1);
    const [error, observer, event] = handler.mock.calls[0] as [unknown, { name: string }, StateEnterEvent];
    expect((error as Error).message).toBe("observer crashed");
    expect(observer.name).toBe("throwing");
    expect(event.state).toBe("ready");
  });

  it("instance.metadata nested objects remain mutable after triggerEvent returns", async () => {
    const definition: WorkflowDefinition = {
      name: "instance-metadata-isolation",
      initialState: "draft",
      states: {
        draft: {
          events: {
            go: { targetState: "done" },
          },
        },
        done: {},
      },
    };
    definitionRegistry.register(definition);

    // Seed instance with nested metadata.
    const instance = await runtime.createInstance({
      workflowName: "instance-metadata-isolation",
      metadata: { audit: { tag: "initial" } },
    });

    // Fire an event — execution context is constructed with deepFreeze({ ...instance.metadata }).
    // Without the fix, that shallow spread still aliases .audit, so freezing recursively freezes the LIVE instance.metadata.audit.
    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });

    // Fetch the instance back — its metadata.audit should still be unfrozen.
    const freshlyFetched = await instanceStore.findByUuid(instance.uuid);
    expect(Object.isFrozen(freshlyFetched!.metadata["audit"] as object)).toBe(false);
  });
});
