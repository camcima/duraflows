import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowInstance } from "../../src/types/runtime.js";
import type { StateEnterEvent } from "../../src/types/observer.js";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowHistoryRecord,
  WorkflowTransactionRunner,
  WorkflowClock,
} from "../../src/types/persistence.js";

class InMemoryInstanceStore implements WorkflowInstanceStore {
  private readonly instances = new Map<string, WorkflowInstance>();
  async create(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.uuid, structuredClone(instance));
  }
  async findByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const inst = this.instances.get(uuid);
    return inst ? structuredClone(inst) : null;
  }
  async lockByUuid(uuid: string): Promise<WorkflowInstance | null> {
    return this.findByUuid(uuid);
  }
  async update(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.uuid, structuredClone(instance));
  }
  async findExpired(limit: number, now: Date): Promise<WorkflowInstance[]> {
    const results: WorkflowInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.expiresAt && inst.expiresAt <= now) {
        results.push(structuredClone(inst));
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}

class InMemoryHistoryStore implements WorkflowHistoryStore {
  private readonly records: Array<WorkflowHistoryRecord & { uuid: string }> = [];
  async append(entry: WorkflowHistoryRecord): Promise<string> {
    const uuid = randomUUID();
    this.records.push({ ...entry, uuid });
    return uuid;
  }
  async findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    const matching = this.records.filter((r) => r.workflowInstanceUuid === workflowInstanceUuid);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? matching.length;
    return matching.slice(offset, offset + limit);
  }
}

class InMemoryTransactionRunner implements WorkflowTransactionRunner {
  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

describe("WorkflowRuntime observers", () => {
  const fixedDate = new Date("2026-04-23T12:00:00.000Z");
  const clock: WorkflowClock = { now: () => fixedDate };

  let runtime: WorkflowRuntime;
  let commandRegistry: InMemoryCommandRegistry;
  let instanceStore: InMemoryInstanceStore;
  let historyStore: InMemoryHistoryStore;
  let definitionRegistry: InMemoryDefinitionRegistry;

  beforeEach(() => {
    definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    commandRegistry = new InMemoryCommandRegistry();
    instanceStore = new InMemoryInstanceStore();
    historyStore = new InMemoryHistoryStore();

    runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore,
      historyStore,
      transactionRunner: new InMemoryTransactionRunner(),
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
      transactionRunner: new InMemoryTransactionRunner(),
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
});
