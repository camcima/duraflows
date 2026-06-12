import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { OnEnterDepthExceededError } from "../../src/errors/index.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowInstance, WorkflowCommand, WorkflowExecutionContext } from "../../src/types/runtime.js";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowHistoryRecord,
  WorkflowTransactionRunner,
  WorkflowClock,
} from "../../src/types/persistence.js";

// ---------------------------------------------------------------------------
// In-memory test helpers
// ---------------------------------------------------------------------------

interface Snapshotable {
  snapshot(): unknown;
  restore(snap: unknown): void;
}

class InMemoryInstanceStore implements WorkflowInstanceStore, Snapshotable {
  private instances = new Map<string, WorkflowInstance>();

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

  snapshot(): unknown {
    return new Map([...this.instances.entries()].map(([k, v]) => [k, structuredClone(v)]));
  }

  restore(snap: unknown): void {
    this.instances = snap as Map<string, WorkflowInstance>;
  }
}

class InMemoryHistoryStore implements WorkflowHistoryStore, Snapshotable {
  private records: Array<WorkflowHistoryRecord & { uuid: string }> = [];

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

  snapshot(): unknown {
    return [...this.records];
  }

  restore(snap: unknown): void {
    this.records = snap as Array<WorkflowHistoryRecord & { uuid: string }>;
  }
}

class InMemoryTransactionRunner implements WorkflowTransactionRunner {
  constructor(private readonly stores: Snapshotable[] = []) {}

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    if (this.stores.length === 0) {
      return callback();
    }
    const snapshots = this.stores.map((s) => s.snapshot());
    try {
      return await callback();
    } catch (err) {
      for (let i = 0; i < this.stores.length; i++) {
        this.stores[i].restore(snapshots[i]);
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WorkflowRuntime onEnter integration", () => {
  const fixedDate = new Date("2025-06-15T12:00:00.000Z");
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

  it("triggerEvent with single onEnter hop produces correct result and history", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-single",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: { targetState: "validating" },
          },
        },
        validating: {
          onEnter: {
            targetState: "validated",
            commands: [{ name: "validate" }],
          },
        },
        validated: {},
      },
    };

    definitionRegistry.register(definition);
    commandRegistry.register("validate", {
      execute: async () => ({ ok: true, code: "VALID" }),
    });

    const instance = await runtime.createInstance({
      workflowName: "on-enter-single",
    });

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      triggerMetadata: { actor: "actor-1" },
    });

    // Returns final state, not intermediate
    expect(result.outcome).toBe("success");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("validated");
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].ok).toBe(true);

    // Verify persisted state
    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated!.currentState).toBe("validated");
    expect(updated!.version).toBe(2); // version 1 from event, version 2 from onEnter hop

    // Verify history — 2 records: event transition + onEnter hop
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(2);

    expect(history[0].fromState).toBe("draft");
    expect(history[0].eventName).toBe("submit");
    expect(history[0].toState).toBe("validating");
    expect(history[0].triggerMetadata?.actor).toBe("actor-1");

    expect(history[1].fromState).toBe("validating");
    expect(history[1].eventName).toBe("onEnter");
    expect(history[1].toState).toBe("validated");
    expect(history[1].triggerMetadata?.source).toBe("onEnter");
  });

  it("multi-hop onEnter chain produces all history records", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-multi",
      initialState: "start",
      states: {
        start: {
          events: {
            go: { targetState: "step1" },
          },
        },
        step1: {
          onEnter: {
            targetState: "step2",
            commands: [{ name: "cmd1" }],
          },
        },
        step2: {
          onEnter: {
            targetState: "step3",
            commands: [{ name: "cmd2" }],
          },
        },
        step3: {},
      },
    };

    definitionRegistry.register(definition);
    commandRegistry.register("cmd1", { execute: async () => ({ ok: true }) });
    commandRegistry.register("cmd2", { execute: async () => ({ ok: true }) });

    const instance = await runtime.createInstance({
      workflowName: "on-enter-multi",
    });

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "go",
    });

    expect(result.toState).toBe("step3");
    expect(result.commandResults).toHaveLength(2);

    // History: event + 2 onEnter hops
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(3);

    expect(history[0].eventName).toBe("go");
    expect(history[0].toState).toBe("step1");

    expect(history[1].eventName).toBe("onEnter");
    expect(history[1].fromState).toBe("step1");
    expect(history[1].toState).toBe("step2");

    expect(history[2].eventName).toBe("onEnter");
    expect(history[2].fromState).toBe("step2");
    expect(history[2].toState).toBe("step3");
  });

  it("onEnter with no targetState runs commands and stays", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-stay",
      initialState: "idle",
      states: {
        idle: {
          events: {
            activate: { targetState: "active" },
          },
        },
        active: {
          onEnter: {
            commands: [{ name: "logActivation" }],
          },
        },
      },
    };

    definitionRegistry.register(definition);
    let commandCalled = false;
    commandRegistry.register("logActivation", {
      execute: async () => {
        commandCalled = true;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({
      workflowName: "on-enter-stay",
    });

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "activate",
    });

    expect(result.toState).toBe("active");
    expect(commandCalled).toBe(true);

    // onEnter hop with no transition still generates a history record
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(2);
    expect(history[1].eventName).toBe("onEnter");
    expect(history[1].fromState).toBe("active");
    expect(history[1].toState).toBe("active");
  });

  it("onEnter command failure transitions to errorState", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-error",
      initialState: "draft",
      states: {
        draft: {
          events: {
            process: { targetState: "processing" },
          },
        },
        processing: {
          onEnter: {
            targetState: "done",
            errorState: "failed",
            commands: [{ name: "doWork" }],
          },
        },
        done: {},
        failed: {},
      },
    };

    definitionRegistry.register(definition);
    commandRegistry.register("doWork", {
      execute: async () => ({ ok: false, code: "WORK_ERROR", message: "Something went wrong" }),
    });

    const instance = await runtime.createInstance({
      workflowName: "on-enter-error",
    });

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "process",
    });

    expect(result.outcome).toBe("failure");
    expect(result.toState).toBe("failed");

    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated!.currentState).toBe("failed");

    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(2);
    expect(history[1].outcome).toBe("failure");
    expect(history[1].toState).toBe("failed");
    expect(history[1].errorMessage).toBe("Something went wrong");
  });

  it("processExpiredWorkflows triggers onEnter on timeout target state", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-timeout",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expiring",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        expiring: {
          onEnter: {
            targetState: "expired",
            commands: [{ name: "cleanup" }],
          },
        },
        expired: {},
      },
    };

    definitionRegistry.register(definition);
    commandRegistry.register("cleanup", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "on-enter-timeout",
    });

    // Manually set expiration in the past to trigger timeout processing
    const pastDate = new Date("2025-06-15T11:00:00.000Z");
    const storedInstance = await instanceStore.findByUuid(instance.uuid);
    storedInstance!.expiresAt = pastDate;
    await instanceStore.update(storedInstance!);

    const expiredResult = await runtime.processExpiredWorkflows();
    expect(expiredResult.processed).toBe(1);

    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated!.currentState).toBe("expired");

    // History: timeout event + onEnter hop
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(2);
    expect(history[0].eventName).toBe("expire");
    expect(history[0].triggerMetadata?.source).toBe("timeout");
    expect(history[1].eventName).toBe("onEnter");
    expect(history[1].triggerMetadata?.source).toBe("onEnter");
  });

  it("createInstance triggers onEnter on initial state", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-initial",
      initialState: "initializing",
      states: {
        initializing: {
          onEnter: {
            targetState: "ready",
            commands: [{ name: "setup" }],
          },
        },
        ready: {},
      },
    };

    definitionRegistry.register(definition);
    commandRegistry.register("setup", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "on-enter-initial",
    });

    // The returned instance should reflect the final state after onEnter
    expect(instance.currentState).toBe("ready");
    expect(instance.version).toBe(1);

    // History: onEnter hop
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(1);
    expect(history[0].eventName).toBe("onEnter");
    expect(history[0].fromState).toBe("initializing");
    expect(history[0].toState).toBe("ready");
  });

  it("context merges correctly through onEnter chain", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-context",
      initialState: "start",
      states: {
        start: {
          context: { startVal: "a" },
          events: {
            go: { targetState: "mid" },
          },
        },
        mid: {
          context: { midVal: "b" },
          onEnter: {
            targetState: "end",
            commands: [{ name: "enrich" }],
          },
        },
        end: {
          context: { endVal: "c" },
        },
      },
    };

    definitionRegistry.register(definition);
    commandRegistry.register("enrich", {
      execute: async (_subject, ctx) => {
        ctx.context["commandVal"] = "d";
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({
      workflowName: "on-enter-context",
    });

    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "go",
    });

    const updated = await instanceStore.findByUuid(instance.uuid);
    // Final context should have:
    // - startVal from initial state context (carried through execution context)
    // - midVal from mid state context (overlaid when entering mid)
    // - commandVal from the enrich command
    // - endVal from end state context (overlaid when entering end)
    expect(updated!.context["startVal"]).toBe("a");
    expect(updated!.context["midVal"]).toBe("b");
    expect(updated!.context["commandVal"]).toBe("d");
    expect(updated!.context["endVal"]).toBe("c");
  });

  it("onEnter history records have correct eventName and triggeredByType", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-history",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: { targetState: "auto" },
          },
        },
        auto: {
          onEnter: {
            targetState: "final",
          },
        },
        final: {},
      },
    };

    definitionRegistry.register(definition);

    const instance = await runtime.createInstance({
      workflowName: "on-enter-history",
    });

    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      triggerMetadata: { actor: "user-1" },
    });

    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(2);

    // Event record — triggered by user
    expect(history[0].eventName).toBe("submit");
    expect(history[0].triggerMetadata?.actor).toBe("user-1");

    // onEnter record — triggered by system
    expect(history[1].eventName).toBe("onEnter");
    expect(history[1].triggerMetadata?.source).toBe("onEnter");
    expect(history[1].triggerMetadata?.actor).toBeUndefined();
  });

  it("triggerEvent works on state reached only via onEnter", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-then-event",
      initialState: "pending",
      states: {
        pending: {
          events: {
            pay: { targetState: "paid" },
          },
        },
        paid: {
          onEnter: {
            targetState: "ready_to_ship",
            commands: [{ name: "allocate" }],
          },
        },
        ready_to_ship: {
          events: {
            ship: { targetState: "shipped" },
          },
        },
        shipped: {},
      },
    };

    definitionRegistry.register(definition);
    commandRegistry.register("allocate", {
      execute: async () => ({ ok: true, code: "ALLOCATED" }),
    });
    const shipCmd: WorkflowCommand = {
      execute: async () => ({ ok: true, code: "SHIPPED" }),
    };
    commandRegistry.register("ship", shipCmd);

    const instance = await runtime.createInstance({
      workflowName: "on-enter-then-event",
    });

    // Event triggers onEnter hop: pending → paid → ready_to_ship
    const payResult = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "pay",
    });

    expect(payResult.toState).toBe("ready_to_ship");

    // Now trigger an event on the state that was only reachable via onEnter
    const shipResult = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "ship",
    });

    expect(shipResult.outcome).toBe("success");
    expect(shipResult.fromState).toBe("ready_to_ship");
    expect(shipResult.toState).toBe("shipped");

    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated!.currentState).toBe("shipped");

    // Full history: pay event + onEnter hop + ship event
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(3);
    expect(history[0].eventName).toBe("pay");
    expect(history[0].toState).toBe("paid");
    expect(history[1].eventName).toBe("onEnter");
    expect(history[1].toState).toBe("ready_to_ship");
    expect(history[2].eventName).toBe("ship");
    expect(history[2].toState).toBe("shipped");
  });

  it("onEnter respects maxOnEnterDepth configuration", async () => {
    // Create a workflow with a 3-hop chain, but limit depth to 2
    const definition: WorkflowDefinition = {
      name: "on-enter-depth",
      initialState: "start",
      states: {
        start: {
          events: {
            go: { targetState: "s1" },
          },
        },
        s1: { onEnter: { targetState: "s2" } },
        s2: { onEnter: { targetState: "s3" } },
        s3: { onEnter: { targetState: "s4" } },
        s4: {},
      },
    };

    definitionRegistry.register(definition);

    // Create runtime with maxOnEnterDepth = 2
    const limitedRuntime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore,
      historyStore,
      transactionRunner: new InMemoryTransactionRunner(),
      clock,
      maxOnEnterDepth: 2,
    });

    const instance = await limitedRuntime.createInstance({
      workflowName: "on-enter-depth",
    });

    await expect(
      limitedRuntime.triggerEvent({
        workflowInstanceUuid: instance.uuid,
        eventName: "go",
      }),
    ).rejects.toThrow(OnEnterDepthExceededError);
  });

  it("createInstance passes fromState=null, toState=initialState, transitionUuid to initial onEnter commands", async () => {
    const definition: WorkflowDefinition = {
      name: "ctx-fields-create",
      initialState: "initializing",
      states: {
        initializing: {
          onEnter: {
            targetState: "ready",
            commands: [{ name: "captureInitCtx" }],
          },
        },
        ready: {},
      },
    };

    definitionRegistry.register(definition);

    let captured: WorkflowExecutionContext | undefined;
    commandRegistry.register("captureInitCtx", {
      execute: async (_subject, ctx) => {
        captured = ctx;
        return { ok: true };
      },
    });

    await runtime.createInstance({ workflowName: "ctx-fields-create" });

    expect(captured).toBeDefined();
    expect(captured!.fromState).toBeNull();
    expect(captured!.toState).toBe("initializing");
    expect(captured!.transitionUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("processExpiredWorkflows: a failing instance does not corrupt other instances or fire observers for the failure", async () => {
    const definition: WorkflowDefinition = {
      name: "per-instance-txn",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expiring",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        expiring: {
          onEnter: {
            targetState: "expired",
            commands: [{ name: "cleanupMaybeThrow" }],
            // Deliberately no errorState — failure throws out of the chain.
          },
        },
        expired: {},
      },
    };

    const definitionRegistry2 = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    const commandRegistry2 = new InMemoryCommandRegistry();
    const instanceStore2 = new InMemoryInstanceStore();
    const historyStore2 = new InMemoryHistoryStore();
    const runtime2 = new WorkflowRuntime({
      definitionRegistry: definitionRegistry2,
      commandRegistry: commandRegistry2,
      instanceStore: instanceStore2,
      historyStore: historyStore2,
      transactionRunner: new InMemoryTransactionRunner([instanceStore2, historyStore2]),
      clock,
    });

    definitionRegistry2.register(definition);
    commandRegistry2.register("cleanupMaybeThrow", {
      execute: async (_subject, ctx) => {
        if (ctx.context["poison"] === true) {
          return { ok: false, code: "POISON" };
        }
        return { ok: true };
      },
    });

    const okA = await runtime2.createInstance({ workflowName: "per-instance-txn" });
    const badB = await runtime2.createInstance({
      workflowName: "per-instance-txn",
      context: { poison: true },
    });
    const okC = await runtime2.createInstance({ workflowName: "per-instance-txn" });

    // Expire all three.
    const past = new Date("2025-06-15T11:00:00.000Z");
    for (const uuid of [okA.uuid, badB.uuid, okC.uuid]) {
      const stored = await instanceStore2.findByUuid(uuid);
      stored!.expiresAt = past;
      await instanceStore2.update(stored!);
    }

    // Register an observer AFTER creation so we only see events from processExpiredWorkflows.
    const observedStates: string[] = [];
    runtime2.addObserver({
      name: "capture-post-expire",
      onEnter: (event) => {
        observedStates.push(`${event.instanceUuid}:${event.state}`);
      },
    });

    const result = await runtime2.processExpiredWorkflows();

    // B failed; A and C succeeded.
    expect(result.processed).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].uuid).toBe(badB.uuid);

    // A and C ended in "expired" state (both timeout event AND onEnter chain completed).
    const finalA = await instanceStore2.findByUuid(okA.uuid);
    expect(finalA!.currentState).toBe("expired");
    const finalC = await instanceStore2.findByUuid(okC.uuid);
    expect(finalC!.currentState).toBe("expired");

    // B's per-instance transaction rolled back → still in "waiting".
    const finalB = await instanceStore2.findByUuid(badB.uuid);
    expect(finalB!.currentState).toBe("waiting");

    // Observer saw 4 events for A and C (2 per instance: expiring + expired), and 0 for B.
    const aEvents = observedStates.filter((s) => s.startsWith(okA.uuid));
    const bEvents = observedStates.filter((s) => s.startsWith(badB.uuid));
    const cEvents = observedStates.filter((s) => s.startsWith(okC.uuid));
    expect(aEvents).toEqual([`${okA.uuid}:expiring`, `${okA.uuid}:expired`]);
    expect(cEvents).toEqual([`${okC.uuid}:expiring`, `${okC.uuid}:expired`]);
    expect(bEvents).toHaveLength(0);

    // B's history must be empty (no timeout event logged, since txn rolled back).
    const bHistory = await historyStore2.findByInstanceUuid(badB.uuid);
    expect(bHistory).toHaveLength(0);
  });

  it("onEnter chain after event has fromState=event.fromState, toState=current state", async () => {
    const definition: WorkflowDefinition = {
      name: "ctx-fields-chain-after-event",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: { targetState: "validating" },
          },
        },
        validating: {
          onEnter: {
            targetState: "validated",
            commands: [{ name: "captureChainCtx" }],
          },
        },
        validated: {},
      },
    };

    definitionRegistry.register(definition);

    let captured: WorkflowExecutionContext | undefined;
    commandRegistry.register("captureChainCtx", {
      execute: async (_subject, ctx) => {
        captured = ctx;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "ctx-fields-chain-after-event" });
    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
    });

    expect(captured).toBeDefined();
    expect(captured!.fromState).toBe("draft");
    expect(captured!.toState).toBe("validating");
    expect(captured!.transitionUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("processExpiredWorkflows: does not count instances that another worker already processed", async () => {
    const definition: WorkflowDefinition = {
      name: "already-processed-not-counted",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        expired: {},
      },
    };

    const definitionRegistry2 = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    const commandRegistry2 = new InMemoryCommandRegistry();
    const instanceStore2 = new InMemoryInstanceStore();
    const historyStore2 = new InMemoryHistoryStore();
    const runtime2 = new WorkflowRuntime({
      definitionRegistry: definitionRegistry2,
      commandRegistry: commandRegistry2,
      instanceStore: instanceStore2,
      historyStore: historyStore2,
      transactionRunner: new InMemoryTransactionRunner(),
      clock,
    });
    definitionRegistry2.register(definition);

    const instance = await runtime2.createInstance({ workflowName: "already-processed-not-counted" });

    // Mark expired.
    const stored = await instanceStore2.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore2.update(stored!);

    // Simulate: between findExpired and lockByUuid, another worker cleared expiresAt.
    const originalLock = instanceStore2.lockByUuid.bind(instanceStore2);
    const lockSpy = vi.spyOn(instanceStore2, "lockByUuid");
    lockSpy.mockImplementationOnce(async (uuid: string) => {
      const row = await originalLock(uuid);
      if (row) {
        row.expiresAt = null;
        await instanceStore2.update(row);
        return originalLock(uuid);
      }
      return row;
    });

    const result = await runtime2.processExpiredWorkflows();

    expect(result.processed).toBe(0);
    expect(result.failed).toHaveLength(0);

    // Instance still in "waiting" (not processed).
    const final = await instanceStore2.findByUuid(instance.uuid);
    expect(final!.currentState).toBe("waiting");

    lockSpy.mockRestore();
  });

  it("processExpiredWorkflows: does not count instances whose current state has no timeout event (only clears the deadline)", async () => {
    const definition: WorkflowDefinition = {
      name: "cleared-deadline-not-counted",
      initialState: "idle",
      states: {
        idle: {}, // No events at all — no timeout
      },
    };

    const definitionRegistry2 = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    const commandRegistry2 = new InMemoryCommandRegistry();
    const instanceStore2 = new InMemoryInstanceStore();
    const historyStore2 = new InMemoryHistoryStore();
    const runtime2 = new WorkflowRuntime({
      definitionRegistry: definitionRegistry2,
      commandRegistry: commandRegistry2,
      instanceStore: instanceStore2,
      historyStore: historyStore2,
      transactionRunner: new InMemoryTransactionRunner(),
      clock,
    });
    definitionRegistry2.register(definition);

    const instance = await runtime2.createInstance({ workflowName: "cleared-deadline-not-counted" });

    // Force a stale expiresAt on a state with no timeout event.
    const stored = await instanceStore2.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore2.update(stored!);

    const result = await runtime2.processExpiredWorkflows();

    expect(result.processed).toBe(0);
    expect(result.failed).toHaveLength(0);

    // Side effect: the stale deadline was cleared, but the instance is still in "idle".
    const final = await instanceStore2.findByUuid(instance.uuid);
    expect(final!.currentState).toBe("idle");
    expect(final!.expiresAt).toBeNull();
  });

  it("can trigger an event from a state reachable only via onEnter.errorState", async () => {
    // This workflow uses a separate "retry" event that moves to a terminal "retried" state,
    // so the onEnter chain does not re-run on retry and the final toState is predictable.
    let callCount = 0;
    const definition: WorkflowDefinition = {
      name: "errorstate-recovery",
      initialState: "processing",
      states: {
        processing: {
          onEnter: {
            targetState: "done",
            errorState: "failed",
            commands: [{ name: "mayFail" }],
          },
        },
        done: {},
        failed: {
          events: {
            retry: { targetState: "retried" },
          },
        },
        retried: {},
      },
    };
    definitionRegistry.register(definition);
    commandRegistry.register("mayFail", {
      execute: async () => {
        callCount++;
        // Fail on the first call (during createInstance), succeed on subsequent calls
        return callCount === 1 ? { ok: false, code: "FAIL" } : { ok: true };
      },
    });

    // Create an instance — onEnter runs, command fails on first call, routes to "failed"
    const instance = await runtime.createInstance({ workflowName: "errorstate-recovery" });
    const stored = await instanceStore.findByUuid(instance.uuid);
    expect(stored!.currentState).toBe("failed");

    // Without the fix, finita throws "State 'failed' not found" because it was never registered.
    // With the fix, the event fires cleanly and moves to "retried".
    const result = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "retry" });
    expect(result.toState).toBe("retried");
  });

  it("processExpiredWorkflows: resolves timeout event from freshly-locked state, not stale snapshot", async () => {
    // Two-state timeout: "waiting" times out to "expired-A"; "racing" times out to "expired-B".
    // An instance starts in "waiting", but BETWEEN findExpired and lockByUuid, another worker moves it to "racing".
    // With the bug: eventName is resolved from the stale "waiting" state, firing the wrong transition.
    // With the fix: eventName is resolved from freshly-locked "racing" state, firing the correct one.

    const definition: WorkflowDefinition = {
      name: "stale-state-race",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            // Normal event so "racing" is in the finita graph (reachable from initial state).
            race: {
              targetState: "racing",
            },
            expire: {
              targetState: "expired-A",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        racing: {
          events: {
            raceTimeout: {
              targetState: "expired-B",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        "expired-A": {},
        "expired-B": {},
      },
    };

    const definitionRegistry2 = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    const commandRegistry2 = new InMemoryCommandRegistry();
    const instanceStore2 = new InMemoryInstanceStore();
    const historyStore2 = new InMemoryHistoryStore();
    const runtime2 = new WorkflowRuntime({
      definitionRegistry: definitionRegistry2,
      commandRegistry: commandRegistry2,
      instanceStore: instanceStore2,
      historyStore: historyStore2,
      transactionRunner: new InMemoryTransactionRunner(),
      clock,
    });

    definitionRegistry2.register(definition);

    const instance = await runtime2.createInstance({ workflowName: "stale-state-race" });

    // Simulate: instance is in "waiting" with an expired deadline.
    const stored = await instanceStore2.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore2.update(stored!);

    // Race: immediately before the per-instance txn, another worker transitions to "racing" and refreshes the deadline but leaves it past.
    // We simulate this by patching lockByUuid to transition the state once, on the first call.
    const originalLock = instanceStore2.lockByUuid.bind(instanceStore2);
    const lockSpy = vi.spyOn(instanceStore2, "lockByUuid");
    lockSpy.mockImplementationOnce(async (uuid: string) => {
      // Another worker already transitioned the instance to "racing" (still expired).
      const row = await originalLock(uuid);
      if (row) {
        row.currentState = "racing";
        // Keep it expired, still past deadline.
        row.expiresAt = new Date("2025-06-15T11:00:00.000Z");
        await instanceStore2.update(row);
        // Return the fresh lock AFTER the mutation — this is what processExpiredWorkflows should see.
        return originalLock(uuid);
      }
      return row;
    });

    const observedStates: string[] = [];
    runtime2.addObserver({
      name: "capture",
      onEnter: (event) => {
        observedStates.push(event.state);
      },
    });

    const result = await runtime2.processExpiredWorkflows();

    // With the fix: the timeout event fired is "raceTimeout" (from "racing"), landing in "expired-B".
    // Without the fix: "expire" (from stale "waiting") would fire, landing in "expired-A" — even though the actual state is "racing".
    const final = await instanceStore2.findByUuid(instance.uuid);
    expect(final!.currentState).toBe("expired-B");
    expect(observedStates).toContain("expired-B");
    expect(observedStates).not.toContain("expired-A");
    expect(result.processed).toBe(1);
    expect(result.failed).toHaveLength(0);

    lockSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Regression tests: deep-clone at runtime boundaries (Fix P2)
  // ---------------------------------------------------------------------------

  it("commands mutating nested context do not mutate the workflow definition's default context", async () => {
    const sharedDefinition: WorkflowDefinition = {
      name: "definition-integrity",
      initialState: "ready",
      states: {
        ready: {
          context: { config: { threshold: 10 } }, // definition-level default
          events: {
            tweak: {
              targetState: "done",
              commands: [{ name: "mutateConfig" }],
            },
          },
        },
        done: {},
      },
    };
    definitionRegistry.register(sharedDefinition);
    commandRegistry.register("mutateConfig", {
      execute: async (_subject, ctx) => {
        (ctx.context.config as { threshold: number }).threshold = 999;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "definition-integrity" });
    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "tweak" });

    // The DEFINITION's default nested config must not have been mutated.
    expect((sharedDefinition.states.ready.context!.config as { threshold: number }).threshold).toBe(10);
  });

  it("createInstance deep-clones caller-supplied nested context (caller keeps ownership)", async () => {
    const definition: WorkflowDefinition = {
      name: "caller-input-isolation",
      initialState: "ready",
      states: { ready: {} },
    };
    definitionRegistry.register(definition);

    const callerContext = { audit: { tag: "caller" } };
    const instance = await runtime.createInstance({
      workflowName: "caller-input-isolation",
      context: callerContext,
    });

    // Caller mutates their own object — must not affect the instance.
    callerContext.audit.tag = "mutated-by-caller";

    const stored = await instanceStore.findByUuid(instance.uuid);
    expect((stored!.context.audit as { tag: string }).tag).toBe("caller");
  });

  it("onEnter merges into instance.context do not alias workflow-definition nested defaults", async () => {
    const sharedDefinition: WorkflowDefinition = {
      name: "onenter-def-integrity",
      initialState: "draft",
      states: {
        draft: {
          events: {
            go: { targetState: "processing" },
          },
        },
        processing: {
          context: { policy: { retries: 3 } }, // definition-level default merged on hop
          onEnter: {
            targetState: "done",
            commands: [{ name: "mutatePolicy" }],
          },
        },
        done: {},
      },
    };
    definitionRegistry.register(sharedDefinition);
    commandRegistry.register("mutatePolicy", {
      execute: async (_subject, ctx) => {
        (ctx.context.policy as { retries: number }).retries = 99;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "onenter-def-integrity" });
    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "go" });

    expect((sharedDefinition.states.processing.context!.policy as { retries: number }).retries).toBe(3);
  });

  it("processExpiredWorkflows routes a mandatory timeout-command failure to errorState with the fallback error message", async () => {
    const definition: WorkflowDefinition = {
      name: "timeout-error-route",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              errorState: "expireFailed",
              timeout: { afterMinutes: 30 },
              commands: [{ name: "bareFail" }],
            },
          },
        },
        expired: {},
        expireFailed: {},
      },
    };

    definitionRegistry.register(definition);
    // Bare failure: no message, no code — exercises the "Command failed" fallback.
    commandRegistry.register("bareFail", {
      execute: async () => ({ ok: false }),
    });

    const instance = await runtime.createInstance({ workflowName: "timeout-error-route" });

    // Force expiration in the past.
    const stored = await instanceStore.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore.update(stored!);

    const result = await runtime.processExpiredWorkflows();
    expect(result.processed).toBe(1);
    expect(result.failed).toHaveLength(0);

    // The instance moved to the errorState, not the targetState.
    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated!.currentState).toBe("expireFailed");

    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(1);
    expect(history[0].eventName).toBe("expire");
    expect(history[0].fromState).toBe("waiting");
    expect(history[0].toState).toBe("expireFailed");
    expect(history[0].outcome).toBe("failure");
    expect(history[0].errorMessage).toBe("Command failed");
  });

  it("processExpiredWorkflows skips an instance that disappeared between scan and re-lock", async () => {
    const definition: WorkflowDefinition = {
      name: "vanished-between-scan-and-lock",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        expired: {},
      },
    };

    definitionRegistry.register(definition);

    const instance = await runtime.createInstance({ workflowName: "vanished-between-scan-and-lock" });

    const stored = await instanceStore.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore.update(stored!);

    // Simulate: instance deleted by another worker between findExpired and lockByUuid.
    const lockSpy = vi.spyOn(instanceStore, "lockByUuid").mockResolvedValueOnce(null);

    const result = await runtime.processExpiredWorkflows();

    expect(result).toEqual({ processed: 0, rejected: 0, failed: [] });

    // Nothing was transitioned or recorded.
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(0);

    lockSpy.mockRestore();
  });

  it("processExpiredWorkflows skips an instance that is no longer expired at re-lock", async () => {
    const definition: WorkflowDefinition = {
      name: "deadline-pushed-out-at-relock",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        expired: {},
      },
    };

    definitionRegistry.register(definition);

    const instance = await runtime.createInstance({ workflowName: "deadline-pushed-out-at-relock" });

    const stored = await instanceStore.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore.update(stored!);

    // Simulate: another worker pushed the deadline into the future between scan and re-lock.
    const originalLock = instanceStore.lockByUuid.bind(instanceStore);
    const lockSpy = vi.spyOn(instanceStore, "lockByUuid");
    lockSpy.mockImplementationOnce(async (uuid: string) => {
      const row = await originalLock(uuid);
      if (row) {
        row.expiresAt = new Date("2025-06-15T13:00:00.000Z"); // future vs fixed clock 12:00
      }
      return row;
    });

    const result = await runtime.processExpiredWorkflows();

    expect(result.processed).toBe(0);
    expect(result.failed).toHaveLength(0);

    // Instance untouched: still waiting, no history.
    const final = await instanceStore.findByUuid(instance.uuid);
    expect(final!.currentState).toBe("waiting");
    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(0);

    lockSpy.mockRestore();
  });

  it("processExpiredWorkflows records a non-Error throw as a failed instance via String(error)", async () => {
    const definition: WorkflowDefinition = {
      name: "non-error-throw",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 30 },
            },
          },
        },
        expired: {},
      },
    };

    definitionRegistry.register(definition);

    const instance = await runtime.createInstance({ workflowName: "non-error-throw" });

    const stored = await instanceStore.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore.update(stored!);

    // Re-lock throws a plain string (not an Error instance).
    const lockSpy = vi.spyOn(instanceStore, "lockByUuid").mockRejectedValueOnce("boom");

    const result = await runtime.processExpiredWorkflows();

    expect(result.processed).toBe(0);
    expect(result.failed).toEqual([{ uuid: instance.uuid, error: "boom" }]);

    lockSpy.mockRestore();
  });

  it("processExpiredWorkflows handles a timeout event without targetState — instance stays in current state", async () => {
    const definition: WorkflowDefinition = {
      name: "timeout-no-target",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            heartbeat: {
              // No targetState: prospectiveToState falls back to the current state.
              timeout: { afterMinutes: 30 },
              commands: [{ name: "recordHeartbeat" }],
            },
          },
        },
      },
    };

    definitionRegistry.register(definition);

    let captured: WorkflowExecutionContext | undefined;
    commandRegistry.register("recordHeartbeat", {
      execute: async (_subject, ctx) => {
        captured = ctx;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "timeout-no-target" });

    const stored = await instanceStore.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore.update(stored!);

    const result = await runtime.processExpiredWorkflows();
    expect(result.processed).toBe(1);
    expect(result.failed).toHaveLength(0);

    // prospectiveToState fell back to the current state.
    expect(captured).toBeDefined();
    expect(captured!.toState).toBe("waiting");

    // On success with no targetState the instance stays where it was.
    const final = await instanceStore.findByUuid(instance.uuid);
    expect(final!.currentState).toBe("waiting");

    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(1);
    expect(history[0].eventName).toBe("heartbeat");
    expect(history[0].fromState).toBe("waiting");
    expect(history[0].toState).toBe("waiting");
    expect(history[0].outcome).toBe("success");
  });

  it("onEnter hop failure with a bare {ok:false} result records the fallback error message", async () => {
    const definition: WorkflowDefinition = {
      name: "on-enter-bare-failure",
      initialState: "draft",
      states: {
        draft: {
          events: {
            process: { targetState: "processing" },
          },
        },
        processing: {
          onEnter: {
            targetState: "done",
            errorState: "failed",
            commands: [{ name: "bareFailOnEnter" }],
          },
        },
        done: {},
        failed: {},
      },
    };

    definitionRegistry.register(definition);
    // Bare failure: no message, no code — exercises the "Command failed" fallback.
    commandRegistry.register("bareFailOnEnter", {
      execute: async () => ({ ok: false }),
    });

    const instance = await runtime.createInstance({ workflowName: "on-enter-bare-failure" });

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "process",
    });

    expect(result.outcome).toBe("failure");
    expect(result.toState).toBe("failed");

    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(2);
    expect(history[1].eventName).toBe("onEnter");
    expect(history[1].toState).toBe("failed");
    expect(history[1].outcome).toBe("failure");
    expect(history[1].errorMessage).toBe("Command failed");
  });
});
