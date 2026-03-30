import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { WorkflowHandle } from "../../src/runtime/workflow-handle.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowInstance } from "../../src/types/runtime.js";
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
// Workflow definition
// ---------------------------------------------------------------------------

const DEFINITION: WorkflowDefinition = {
  name: "handle-wf",
  initialState: "new",
  states: {
    new: {
      context: { step: "new" },
      events: {
        submit: {
          targetState: "submitted",
          commands: [{ name: "validate" }],
        },
        cancel: {
          targetState: "cancelled",
        },
      },
    },
    submitted: {
      context: { step: "submitted" },
      events: {
        approve: {
          targetState: "approved",
        },
      },
    },
    approved: {},
    cancelled: {},
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WorkflowHandle lifecycle", () => {
  const fixedDate = new Date("2025-06-15T12:00:00.000Z");
  const clock: WorkflowClock = { now: () => fixedDate };

  let runtime: WorkflowRuntime;
  let commandRegistry: InMemoryCommandRegistry;

  beforeEach(() => {
    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    definitionRegistry.register(DEFINITION);

    commandRegistry = new InMemoryCommandRegistry();
    commandRegistry.register("validate", {
      execute: async (_subject, ctx) => {
        ctx.context["validatedAt"] = ctx.now.toISOString();
        return { ok: true, code: "VALID" };
      },
    });

    runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore: new InMemoryInstanceStore(),
      historyStore: new InMemoryHistoryStore(),
      transactionRunner: new InMemoryTransactionRunner(),
      clock,
    });
  });

  it("getHandle() returns a WorkflowHandle with the correct uuid", () => {
    const handle = runtime.getHandle("some-uuid");

    expect(handle).toBeInstanceOf(WorkflowHandle);
    expect(handle.uuid).toBe("some-uuid");
  });

  it("drives a full lifecycle through the handle", async () => {
    // Create instance via runtime, then get a handle
    const instance = await runtime.createInstance({
      workflowName: "handle-wf",
      metadata: { testId: "lifecycle" },
    });
    const handle = runtime.getHandle(instance.uuid);

    // getInstance returns the current state
    const fetched = await handle.getInstance();
    expect(fetched).not.toBeNull();
    expect(fetched!.currentState).toBe("new");
    expect(fetched!.context).toEqual({ step: "new" });
    expect(fetched!.metadata).toEqual({ testId: "lifecycle" });

    // getAvailableEvents returns events for the current state
    const events = await handle.getAvailableEvents();
    expect(events).toHaveLength(2);
    const eventNames = events.map((e) => e.eventName).sort();
    expect(eventNames).toEqual(["cancel", "submit"]);

    // triggerEvent transitions the workflow
    const result = await handle.triggerEvent("submit", {
      triggerMetadata: { actor: "test-user" },
    });
    expect(result.outcome).toBe("success");
    expect(result.fromState).toBe("new");
    expect(result.toState).toBe("submitted");
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].code).toBe("VALID");

    // getInstance reflects the new state
    const updated = await handle.getInstance();
    expect(updated!.currentState).toBe("submitted");
    expect(updated!.context).toEqual({
      step: "submitted",
      validatedAt: fixedDate.toISOString(),
    });

    // getAvailableEvents reflects the new state
    const newEvents = await handle.getAvailableEvents();
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0].eventName).toBe("approve");

    // getHistory returns the transition history
    const history = await handle.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].fromState).toBe("new");
    expect(history[0].toState).toBe("submitted");
    expect(history[0].eventName).toBe("submit");
    expect(history[0].triggerMetadata).toEqual({ actor: "test-user" });

    // Second transition
    await handle.triggerEvent("approve");

    const final = await handle.getInstance();
    expect(final!.currentState).toBe("approved");

    const fullHistory = await handle.getHistory();
    expect(fullHistory).toHaveLength(2);
  });

  it("handle produces identical results to direct runtime calls", async () => {
    const instance = await runtime.createInstance({
      workflowName: "handle-wf",
    });
    const handle = runtime.getHandle(instance.uuid);

    // Compare getInstance
    const directInstance = await runtime.getInstance(instance.uuid);
    const handleInstance = await handle.getInstance();
    expect(handleInstance).toEqual(directInstance);

    // Compare getAvailableEvents
    const directEvents = await runtime.getAvailableEvents({
      workflowInstanceUuid: instance.uuid,
    });
    const handleEvents = await handle.getAvailableEvents();
    expect(handleEvents).toEqual(directEvents);

    // Compare getHistory
    const directHistory = await runtime.getHistory(instance.uuid);
    const handleHistory = await handle.getHistory();
    expect(handleHistory).toEqual(directHistory);
  });
});
