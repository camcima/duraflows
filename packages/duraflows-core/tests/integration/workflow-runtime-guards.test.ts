import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { InMemoryGuardRegistry } from "../../src/registry/guard-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowInstance } from "../../src/types/runtime.js";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowHistoryRecord,
  WorkflowTransactionRunner,
} from "../../src/types/persistence.js";

class InMemoryInstanceStore implements WorkflowInstanceStore {
  private readonly instances = new Map<string, WorkflowInstance>();
  async create(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.uuid, structuredClone(instance));
  }
  async findByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const i = this.instances.get(uuid);
    return i ? structuredClone(i) : null;
  }
  async lockByUuid(uuid: string): Promise<WorkflowInstance | null> {
    return this.findByUuid(uuid);
  }
  async update(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.uuid, structuredClone(instance));
  }
  async findExpired(_limit: number, now: Date): Promise<WorkflowInstance[]> {
    return [...this.instances.values()].filter(
      (i) => i.expiresAt !== null && i.expiresAt !== undefined && i.expiresAt <= now,
    );
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
  async runInTransaction<T>(cb: () => Promise<T>): Promise<T> {
    return cb();
  }
}

const DEFINITION: WorkflowDefinition = {
  name: "guarded-wf",
  initialState: "draft",
  states: {
    draft: {
      events: {
        submit: {
          guard: { name: "isVerified" },
          targetState: "submitted",
          commands: [{ name: "notify" }],
        },
      },
    },
    submitted: {
      onEnter: { targetState: "indexed" },
    },
    indexed: {},
  },
};

function buildRuntime(guardOutcome: boolean) {
  const cmdRegistry = new InMemoryCommandRegistry();
  let notifyCalls = 0;
  cmdRegistry.register("notify", {
    execute: async () => {
      notifyCalls++;
      return { ok: true };
    },
  });

  const guardRegistry = new InMemoryGuardRegistry();
  guardRegistry.register("isVerified", {
    name: "isVerified",
    evaluate: () => guardOutcome,
  });

  const definitionRegistry = new InMemoryDefinitionRegistry({
    validator: new WorkflowValidator(),
    compiler: new WorkflowCompiler(),
    validationOptions: {
      knownCommandNames: new Set(["notify"]),
      knownGuardNames: new Set(["isVerified"]),
    },
  });
  definitionRegistry.register(DEFINITION);

  const instanceStore = new InMemoryInstanceStore();
  const historyStore = new InMemoryHistoryStore();
  const transactionRunner = new InMemoryTransactionRunner();

  const runtime = new WorkflowRuntime({
    definitionRegistry,
    commandRegistry: cmdRegistry,
    guardRegistry,
    instanceStore,
    historyStore,
    transactionRunner,
    clock: { now: () => new Date("2026-04-27T00:00:00Z") },
  });

  return { runtime, instanceStore, historyStore, getNotifyCalls: () => notifyCalls };
}

describe("WorkflowRuntime guards", () => {
  it("guard rejection: instance unchanged, history written, no commands run, no onEnter", async () => {
    const { runtime, instanceStore, historyStore, getNotifyCalls } = buildRuntime(false);

    const created = await runtime.createInstance({ workflowName: "guarded-wf" });
    const before = await instanceStore.findByUuid(created.uuid);

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: created.uuid,
      eventName: "submit",
    });

    expect(result.outcome).toBe("guard-rejected");
    expect(result.rejectedBy).toBe("isVerified");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("draft");
    expect(result.commandResults).toEqual([]);

    const after = await instanceStore.findByUuid(created.uuid);
    expect(after?.currentState).toBe("draft");
    expect(after?.version).toBe(before?.version);

    const history = await historyStore.findByInstanceUuid(created.uuid);
    const reject = history.find((h) => h.outcome === "guard-rejected");
    expect(reject).toBeDefined();
    expect(reject?.fromState).toBe("draft");
    expect(reject?.toState).toBe("draft");
    expect(reject?.eventName).toBe("submit");
    expect(reject?.rejectedBy).toBe("isVerified");
    expect(reject?.commandResultsJson).toEqual([]);

    expect(getNotifyCalls()).toBe(0);
  });

  it("guard pass: normal transition, commands run, onEnter chains", async () => {
    const { runtime, instanceStore, getNotifyCalls } = buildRuntime(true);

    const created = await runtime.createInstance({ workflowName: "guarded-wf" });
    const result = await runtime.triggerEvent({
      workflowInstanceUuid: created.uuid,
      eventName: "submit",
    });

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("indexed"); // onEnter advanced past "submitted"
    expect(getNotifyCalls()).toBe(1);

    const after = await instanceStore.findByUuid(created.uuid);
    expect(after?.currentState).toBe("indexed");
  });

  it("does not fire observer events on guard rejection", async () => {
    const { runtime } = buildRuntime(false);
    const observerCalls: string[] = [];
    runtime.addObserver({
      name: "spy",
      onEnter: (event) => {
        observerCalls.push(`${event.fromState ?? "null"}->${event.toState}`);
      },
    });

    const created = await runtime.createInstance({ workflowName: "guarded-wf" });
    // Reset to ignore the create-time onEnter event for the initial state.
    observerCalls.length = 0;

    await runtime.triggerEvent({ workflowInstanceUuid: created.uuid, eventName: "submit" });

    expect(observerCalls).toEqual([]);
  });

  it("workflow can advance after a previous guard rejection when the guard later passes", async () => {
    // Build a runtime whose guard outcome is mutable across calls.
    const cmdRegistry = new InMemoryCommandRegistry();
    cmdRegistry.register("notify", { execute: async () => ({ ok: true }) });

    let guardOutcome = false;
    const guardRegistry = new InMemoryGuardRegistry();
    guardRegistry.register("isVerified", {
      name: "isVerified",
      evaluate: () => guardOutcome,
    });

    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
      validationOptions: {
        knownCommandNames: new Set(["notify"]),
        knownGuardNames: new Set(["isVerified"]),
      },
    });
    definitionRegistry.register(DEFINITION);

    const runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry: cmdRegistry,
      guardRegistry,
      instanceStore: new InMemoryInstanceStore(),
      historyStore: new InMemoryHistoryStore(),
      transactionRunner: new InMemoryTransactionRunner(),
      clock: { now: () => new Date("2026-04-27T00:00:00Z") },
    });

    const created = await runtime.createInstance({ workflowName: "guarded-wf" });

    const first = await runtime.triggerEvent({ workflowInstanceUuid: created.uuid, eventName: "submit" });
    expect(first.outcome).toBe("guard-rejected");

    guardOutcome = true;
    const second = await runtime.triggerEvent({ workflowInstanceUuid: created.uuid, eventName: "submit" });
    expect(second.outcome).toBe("success");
    expect(second.toState).toBe("indexed");
  });

  it("timeout guard rejection: disarms expiresAt, writes one history row, second sweep adds no rows", async () => {
    // Mutable clock so we can advance time.
    let clockTime = new Date("2026-04-27T00:00:00Z");
    const clock = { now: () => clockTime };

    const timeoutDefinition: WorkflowDefinition = {
      name: "timeout-guarded-wf",
      initialState: "waiting",
      states: {
        waiting: {
          events: {
            expire: {
              guard: { name: "isVerified" },
              targetState: "expired",
              timeout: { afterMinutes: 1 },
            },
          },
        },
        expired: {},
      },
    };

    const cmdRegistry = new InMemoryCommandRegistry();
    const guardRegistry = new InMemoryGuardRegistry();
    guardRegistry.register("isVerified", {
      name: "isVerified",
      evaluate: () => false, // always reject
    });

    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
      validationOptions: {
        knownCommandNames: new Set<string>(),
        knownGuardNames: new Set(["isVerified"]),
      },
    });
    definitionRegistry.register(timeoutDefinition);

    const instanceStore = new InMemoryInstanceStore();
    const historyStore = new InMemoryHistoryStore();
    const transactionRunner = new InMemoryTransactionRunner();

    const runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry: cmdRegistry,
      guardRegistry,
      instanceStore,
      historyStore,
      transactionRunner,
      clock,
    });

    const created = await runtime.createInstance({ workflowName: "timeout-guarded-wf" });

    // Advance clock past the 1-minute timeout deadline.
    clockTime = new Date("2026-04-27T00:02:00Z");

    const firstResult = await runtime.processExpiredWorkflows();
    expect(firstResult.processed).toBe(1);
    expect(firstResult.failed).toHaveLength(0);

    // expiresAt must be disarmed and state unchanged.
    const afterFirst = await instanceStore.findByUuid(created.uuid);
    expect(afterFirst?.expiresAt).toBeNull();
    expect(afterFirst?.currentState).toBe("waiting");

    // Exactly one guard-rejected history row.
    const historyAfterFirst = await historyStore.findByInstanceUuid(created.uuid);
    const rejectedRows = historyAfterFirst.filter((h) => h.outcome === "guard-rejected");
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0].eventName).toBe("expire");
    expect(rejectedRows[0].rejectedBy).toBe("isVerified");

    // Second sweep must NOT pick up the instance again (expiresAt is null).
    const secondResult = await runtime.processExpiredWorkflows();
    expect(secondResult.processed).toBe(0);

    const historyAfterSecond = await historyStore.findByInstanceUuid(created.uuid);
    const rejectedRowsAfterSecond = historyAfterSecond.filter((h) => h.outcome === "guard-rejected");
    expect(rejectedRowsAfterSecond).toHaveLength(1); // still just one, no new row
  });

  it("when guard passes and a command fails, normal failure path still routes to errorState", async () => {
    // Regression: ensure the new short-circuit didn't break the existing failure path.
    const cmdRegistry = new InMemoryCommandRegistry();
    cmdRegistry.register("notify", {
      execute: async () => ({ ok: false, code: "BOOM", message: "kaboom" }),
    });
    const guardRegistry = new InMemoryGuardRegistry();
    guardRegistry.register("isVerified", { name: "isVerified", evaluate: () => true });

    const definitionWithErrorState: WorkflowDefinition = {
      name: "guarded-err",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
              errorState: "submitFailed",
              commands: [{ name: "notify" }],
            },
          },
        },
        submitted: {},
        submitFailed: {},
      },
    };

    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
      validationOptions: {
        knownCommandNames: new Set(["notify"]),
        knownGuardNames: new Set(["isVerified"]),
      },
    });
    definitionRegistry.register(definitionWithErrorState);

    const runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry: cmdRegistry,
      guardRegistry,
      instanceStore: new InMemoryInstanceStore(),
      historyStore: new InMemoryHistoryStore(),
      transactionRunner: new InMemoryTransactionRunner(),
      clock: { now: () => new Date("2026-04-27T00:00:00Z") },
    });

    const created = await runtime.createInstance({ workflowName: "guarded-err" });
    const result = await runtime.triggerEvent({
      workflowInstanceUuid: created.uuid,
      eventName: "submit",
    });

    expect(result.outcome).toBe("failure");
    expect(result.toState).toBe("submitFailed");
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].ok).toBe(false);
  });
});
