import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { WorkflowError } from "../../src/errors/index.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowInstance, WorkflowExecutionContext } from "../../src/types/runtime.js";
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
// Workflow definition used across the suite
// ---------------------------------------------------------------------------

const DEFINITION: WorkflowDefinition = {
  name: "order-workflow",
  initialState: "pending",
  states: {
    pending: {
      events: {
        approve: {
          targetState: "approved",
          commands: [{ name: "validateOrder" }],
          metadata: { label: "Approve Order" },
        },
        autoProcess: {
          targetState: "processing",
          commands: [{ name: "processOrder" }],
        },
        expire: {
          targetState: "expired",
          timeout: { afterHours: 1 },
        },
      },
    },
    approved: {
      events: {
        ship: {
          targetState: "shipped",
          errorState: "shipFailed",
          commands: [{ name: "shipOrder" }],
        },
      },
    },
    processing: {},
    expired: {},
    shipped: {},
    shipFailed: {},
    completed: {},
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WorkflowRuntime.getAvailableEvents", () => {
  const fixedDate = new Date("2025-06-15T12:00:00.000Z");
  const clock: WorkflowClock = { now: () => fixedDate };

  let runtime: WorkflowRuntime;
  let instanceUuid: string;
  let definitionRegistry: InMemoryDefinitionRegistry;
  let commandRegistry: InMemoryCommandRegistry;
  let instanceStore: InMemoryInstanceStore;

  beforeEach(async () => {
    definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    definitionRegistry.register(DEFINITION);

    commandRegistry = new InMemoryCommandRegistry();
    commandRegistry.register("validateOrder", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("processOrder", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("shipOrder", {
      execute: async () => ({ ok: true }),
    });

    instanceStore = new InMemoryInstanceStore();

    runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore,
      historyStore: new InMemoryHistoryStore(),
      transactionRunner: new InMemoryTransactionRunner(),
      clock,
    });

    const instance = await runtime.createInstance({
      workflowName: "order-workflow",
    });
    instanceUuid = instance.uuid;
  });

  it("returns all events for a state", async () => {
    const events = await runtime.getAvailableEvents({
      workflowInstanceUuid: instanceUuid,
    });

    const names = events.map((e) => e.eventName).sort();
    expect(names).toEqual(["approve", "autoProcess", "expire"]);
  });

  it("returns empty array for terminal state (state with no events)", async () => {
    // Transition to "processing" which is a terminal state (no events)
    await runtime.triggerEvent({
      workflowInstanceUuid: instanceUuid,
      eventName: "autoProcess",
    });

    const events = await runtime.getAvailableEvents({
      workflowInstanceUuid: instanceUuid,
    });

    expect(events).toEqual([]);
  });

  it("returns correct event metadata (targetState, errorState, hasCommands, hasTimeout)", async () => {
    const events = await runtime.getAvailableEvents({
      workflowInstanceUuid: instanceUuid,
    });

    // Check the "approve" event
    const approve = events.find((e) => e.eventName === "approve");
    expect(approve).toBeDefined();
    expect(approve!.targetState).toBe("approved");
    expect(approve!.errorState).toBeUndefined();
    expect(approve!.hasCommands).toBe(true);
    expect(approve!.hasTimeout).toBe(false);
    expect(approve!.metadata).toEqual({ label: "Approve Order" });

    // Check the "autoProcess" event
    const autoProcess = events.find((e) => e.eventName === "autoProcess");
    expect(autoProcess).toBeDefined();
    expect(autoProcess!.targetState).toBe("processing");
    expect(autoProcess!.errorState).toBeUndefined();
    expect(autoProcess!.hasCommands).toBe(true);
    expect(autoProcess!.hasTimeout).toBe(false);

    // Check the "expire" event (has timeout, no commands)
    const expire = events.find((e) => e.eventName === "expire");
    expect(expire).toBeDefined();
    expect(expire!.targetState).toBe("expired");
    expect(expire!.hasCommands).toBe(false);
    expect(expire!.hasTimeout).toBe(true);
  });

  it("throws WorkflowError for non-existent workflow instance UUID", async () => {
    const bogusUuid = randomUUID();

    await expect(
      runtime.getAvailableEvents({
        workflowInstanceUuid: bogusUuid,
      }),
    ).rejects.toThrow(WorkflowError);

    await expect(
      runtime.getAvailableEvents({
        workflowInstanceUuid: bogusUuid,
      }),
    ).rejects.toThrow(`Workflow instance "${bogusUuid}" not found`);
  });

  it("triggerEvent passes fromState, toState, transitionUuid to event commands", async () => {
    const definition: WorkflowDefinition = {
      name: "ctx-fields-event",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              targetState: "submitted",
              commands: [{ name: "captureCtx" }],
            },
          },
        },
        submitted: {},
      },
    };

    definitionRegistry.register(definition);

    let captured: WorkflowExecutionContext | undefined;
    commandRegistry.register("captureCtx", {
      execute: async (_subject, ctx) => {
        captured = ctx;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "ctx-fields-event" });
    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "submit" });

    expect(captured).toBeDefined();
    expect(captured!.fromState).toBe("draft");
    expect(captured!.toState).toBe("submitted");
    expect(captured!.transitionUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("processExpiredWorkflows passes fromState, toState, transitionUuid to timeout commands", async () => {
    const definition: WorkflowDefinition = {
      name: "ctx-fields-timeout",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              targetState: "expired",
              timeout: { afterMinutes: 30 },
              commands: [{ name: "captureTimeoutCtx" }],
            },
          },
        },
        expired: {},
      },
    };

    definitionRegistry.register(definition);

    let captured: WorkflowExecutionContext | undefined;
    commandRegistry.register("captureTimeoutCtx", {
      execute: async (_subject, ctx) => {
        captured = ctx;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "ctx-fields-timeout" });

    // Force expiration in the past
    const stored = await instanceStore.findByUuid(instance.uuid);
    stored!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    await instanceStore.update(stored!);

    await runtime.processExpiredWorkflows();

    expect(captured).toBeDefined();
    expect(captured!.fromState).toBe("waiting");
    expect(captured!.toState).toBe("expired");
    expect(captured!.transitionUuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("triggerEvent returns outcome=success when a final best-effort command fails", async () => {
    const definition: WorkflowDefinition = {
      name: "outcome-besteffort-last",
      initialState: "draft",
      states: {
        draft: {
          events: {
            go: {
              targetState: "processing",
            },
          },
        },
        processing: {
          onEnter: {
            targetState: "done",
            commands: [{ name: "beFail" }],
          },
        },
        done: {},
      },
    };
    definitionRegistry.register(definition);

    commandRegistry.register("beFail", {
      bestEffort: true,
      execute: async () => ({ ok: false, code: "BE_FAIL" }),
    });

    const instance = await runtime.createInstance({ workflowName: "outcome-besteffort-last" });
    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "go",
    });

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("done");
  });

  it("triggerEvent returns outcome=failure when an onEnter hop routes to errorState", async () => {
    const definition: WorkflowDefinition = {
      name: "outcome-errorstate-routing",
      initialState: "draft",
      states: {
        draft: {
          events: {
            go: { targetState: "processing" },
          },
        },
        processing: {
          onEnter: {
            targetState: "done",
            errorState: "failed",
            commands: [{ name: "mandatoryFail" }],
          },
        },
        done: {},
        failed: {},
      },
    };
    definitionRegistry.register(definition);

    commandRegistry.register("mandatoryFail", {
      execute: async () => ({ ok: false, code: "BAD" }),
    });

    const instance = await runtime.createInstance({ workflowName: "outcome-errorstate-routing" });
    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "go",
    });

    expect(result.outcome).toBe("failure");
    expect(result.toState).toBe("failed");
  });

  it("command-only event stays in current state on success", async () => {
    const definition: WorkflowDefinition = {
      name: "command-only",
      initialState: "active",
      states: {
        active: {
          events: {
            ping: {
              commands: [{ name: "emitPing" }],
            },
          },
        },
      },
    };
    definitionRegistry.register(definition);

    let pingCount = 0;
    commandRegistry.register("emitPing", {
      execute: async () => {
        pingCount++;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "command-only" });
    const result = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "ping" });

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("active");
    expect(pingCount).toBe(1);

    // Still in active after the event
    const stored = await instanceStore.findByUuid(instance.uuid);
    expect(stored!.currentState).toBe("active");
  });

  it("failure-only event (errorState, no targetState) routes to errorState on command failure", async () => {
    const definition: WorkflowDefinition = {
      name: "failure-only",
      initialState: "processing",
      states: {
        processing: {
          events: {
            try: {
              errorState: "failed",
              commands: [{ name: "alwaysFails" }],
            },
          },
        },
        failed: {},
      },
    };
    definitionRegistry.register(definition);

    commandRegistry.register("alwaysFails", {
      execute: async () => ({ ok: false, code: "NOPE" }),
    });

    const instance = await runtime.createInstance({ workflowName: "failure-only" });
    const result = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "try" });

    expect(result.outcome).toBe("failure");
    expect(result.toState).toBe("failed");
  });

  it("failure-only event stays in current state when commands succeed", async () => {
    const definition: WorkflowDefinition = {
      name: "failure-only-success-path",
      initialState: "processing",
      states: {
        processing: {
          events: {
            try: {
              errorState: "failed",
              commands: [{ name: "ok" }],
            },
          },
        },
        failed: {},
      },
    };
    definitionRegistry.register(definition);

    commandRegistry.register("ok", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({ workflowName: "failure-only-success-path" });
    const result = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "try" });

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("processing");
  });

  it("self-transition (targetState equals current state) lands back in the same state on success", async () => {
    // Common retry pattern: an event on state X with targetState: X re-runs
    // commands and stays in X on success.
    const definition: WorkflowDefinition = {
      name: "self-transition",
      initialState: "in_progress",
      states: {
        in_progress: {
          events: {
            retry: {
              targetState: "in_progress",
              errorState: "failed",
              commands: [{ name: "doWork" }],
            },
          },
        },
        failed: {},
      },
    };
    definitionRegistry.register(definition);

    let attempts = 0;
    commandRegistry.register("doWork", {
      execute: async () => {
        attempts++;
        return { ok: true };
      },
    });

    const instance = await runtime.createInstance({ workflowName: "self-transition" });

    const first = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "retry" });
    expect(first.outcome).toBe("success");
    expect(first.fromState).toBe("in_progress");
    expect(first.toState).toBe("in_progress");

    const second = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "retry" });
    expect(second.outcome).toBe("success");
    expect(second.toState).toBe("in_progress");

    // Two successful self-transitions, command ran on both.
    expect(attempts).toBe(2);
    const stored = await instanceStore.findByUuid(instance.uuid);
    expect(stored!.currentState).toBe("in_progress");
  });

  it("merged self-loop (targetState === errorState === current state) lands in place on either outcome", async () => {
    // The fix-the-merge case: targetState and errorState both point at the
    // current state. ProcessBuilder would reject two conflicting-condition
    // transitions for the same (from, event, to) triple, so the compiler
    // collapses them into a single permissive transition. Both success and
    // failure outcomes must still resolve correctly and surface in the result.
    const definition: WorkflowDefinition = {
      name: "merged-self-loop",
      initialState: "active",
      states: {
        active: {
          events: {
            poll: {
              targetState: "active",
              errorState: "active",
              commands: [{ name: "checkStatus" }],
            },
          },
        },
      },
    };
    definitionRegistry.register(definition);

    let nextOutcome: "ok" | "fail" = "ok";
    commandRegistry.register("checkStatus", {
      execute: async () => (nextOutcome === "ok" ? { ok: true } : { ok: false, code: "PENDING" }),
    });

    const instance = await runtime.createInstance({ workflowName: "merged-self-loop" });

    nextOutcome = "ok";
    const ok = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "poll" });
    expect(ok.outcome).toBe("success");
    expect(ok.toState).toBe("active");

    nextOutcome = "fail";
    const fail = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "poll" });
    expect(fail.outcome).toBe("failure");
    expect(fail.toState).toBe("active");

    const stored = await instanceStore.findByUuid(instance.uuid);
    expect(stored!.currentState).toBe("active");
  });
});
