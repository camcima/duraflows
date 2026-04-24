import { describe, it, expect, beforeEach } from "vitest";
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
});
