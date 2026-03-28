import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowInstance, WorkflowCommand } from "../../src/types/runtime.js";
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
    const matching = this.records.filter(
      (r) => r.workflowInstanceUuid === workflowInstanceUuid,
    );
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
// Workflow definition for lifecycle tests
// ---------------------------------------------------------------------------

const DEFINITION: WorkflowDefinition = {
  name: "lifecycle-wf",
  initialState: "draft",
  states: {
    draft: {
      context: { step: "initial", attempts: 0 },
      events: {
        submit: {
          targetState: "submitted",
          errorState: "submitFailed",
          commands: [{ name: "validate" }, { name: "enrich" }],
        },
      },
    },
    submitted: {
      context: { step: "submitted" },
      events: {
        approve: {
          targetState: "approved",
          commands: [{ name: "notifyApproval" }],
        },
      },
    },
    submitFailed: {
      context: { step: "error" },
    },
    approved: {},
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WorkflowRuntime full lifecycle", () => {
  const fixedDate = new Date("2025-06-15T12:00:00.000Z");
  const clock: WorkflowClock = { now: () => fixedDate };

  let runtime: WorkflowRuntime;
  let commandRegistry: InMemoryCommandRegistry;
  let instanceStore: InMemoryInstanceStore;
  let historyStore: InMemoryHistoryStore;

  beforeEach(() => {
    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    definitionRegistry.register(DEFINITION);

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

  it("creates an instance with correct initial state and context", async () => {
    commandRegistry.register("validate", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("enrich", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("notifyApproval", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "lifecycle-wf",
      context: { customField: "hello" },
      metadata: { createdBy: "test-actor" },
      trigger: { type: "system" },
    });

    expect(instance.workflowName).toBe("lifecycle-wf");
    expect(instance.currentState).toBe("draft");
    expect(instance.version).toBe(0);
    expect(instance.createdAt).toEqual(fixedDate);
    expect(instance.updatedAt).toEqual(fixedDate);

    // State context is merged first, then user context wins on top
    expect(instance.context).toEqual({
      step: "initial",
      attempts: 0,
      customField: "hello",
    });

    expect(instance.metadata).toEqual({ createdBy: "test-actor" });
  });

  it("transitions to target state on success event with commands", async () => {
    commandRegistry.register("validate", {
      execute: async () => ({ ok: true, code: "VALID" }),
    });
    commandRegistry.register("enrich", {
      execute: async (_subject, ctx) => {
        ctx.context["enriched"] = true;
        return { ok: true };
      },
    });
    commandRegistry.register("notifyApproval", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "lifecycle-wf",
      trigger: { type: "system" },
    });

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      trigger: { type: "system" },
    });

    expect(result.outcome).toBe("success");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("submitted");
    expect(result.commandResults).toHaveLength(2);
    expect(result.commandResults[0].ok).toBe(true);
    expect(result.commandResults[1].ok).toBe(true);

    // Verify persisted instance state
    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated).not.toBeNull();
    expect(updated!.currentState).toBe("submitted");
    expect(updated!.version).toBe(1);
  });

  it("transitions to error state on failure event", async () => {
    commandRegistry.register("validate", {
      execute: async () => ({
        ok: false,
        code: "VALIDATION_FAILED",
        message: "Invalid data",
      }),
    });
    commandRegistry.register("enrich", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("notifyApproval", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "lifecycle-wf",
      trigger: { type: "system" },
    });

    const result = await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      trigger: { type: "system" },
    });

    expect(result.outcome).toBe("failure");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("submitFailed");
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].ok).toBe(false);
    expect(result.commandResults[0].code).toBe("VALIDATION_FAILED");

    // Verify persisted instance state
    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated).not.toBeNull();
    expect(updated!.currentState).toBe("submitFailed");
  });

  it("records full history with correct from/to states and outcomes", async () => {
    commandRegistry.register("validate", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("enrich", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("notifyApproval", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "lifecycle-wf",
      trigger: { type: "system" },
    });

    // First transition: draft -> submitted
    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      trigger: { type: "system" },
    });

    // Second transition: submitted -> approved
    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "approve",
      trigger: { type: "system" },
    });

    const history = await historyStore.findByInstanceUuid(instance.uuid);
    expect(history).toHaveLength(2);

    // First record
    expect(history[0].fromState).toBe("draft");
    expect(history[0].eventName).toBe("submit");
    expect(history[0].toState).toBe("submitted");
    expect(history[0].outcome).toBe("success");
    expect(history[0].triggeredByType).toBe("system");

    // Second record
    expect(history[1].fromState).toBe("submitted");
    expect(history[1].eventName).toBe("approve");
    expect(history[1].toState).toBe("approved");
    expect(history[1].outcome).toBe("success");
    expect(history[1].triggeredByType).toBe("system");
  });

  it("merges state context on transition", async () => {
    commandRegistry.register("validate", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("enrich", {
      execute: async (_subject, ctx) => {
        // Command writes a value to the context
        ctx.context["enrichedData"] = "fromCommand";
        return { ok: true };
      },
    });
    commandRegistry.register("notifyApproval", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "lifecycle-wf",
      context: { userProvided: "value1" },
      trigger: { type: "system" },
    });

    // Verify initial context: state context merged with user context
    expect(instance.context).toEqual({
      step: "initial",
      attempts: 0,
      userProvided: "value1",
    });

    // Transition: draft -> submitted
    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      trigger: { type: "system" },
    });

    // After transition:
    // 1. Command writes "enrichedData" to the execution context
    // 2. New state (submitted) has context { step: "submitted" }
    // 3. Final context = command-mutated context + new state context overlay
    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated).not.toBeNull();

    // State-defined context for "submitted" overrides "step"
    expect(updated!.context["step"]).toBe("submitted");
    // Command-written context persists
    expect(updated!.context["enrichedData"]).toBe("fromCommand");
    // User-provided context carries forward
    expect(updated!.context["userProvided"]).toBe("value1");
    // "attempts" from the draft state context was in the instance context and
    // carries forward because it is part of the execution context
    expect(updated!.context["attempts"]).toBe(0);
  });

  it("keeps metadata immutable (deep frozen) during execution", async () => {
    let capturedMetadata: Readonly<Record<string, unknown>> | undefined;

    commandRegistry.register("validate", {
      execute: async (_subject, ctx) => {
        capturedMetadata = ctx.metadata;

        // Attempting to mutate should throw because metadata is deep-frozen
        expect(() => {
          (ctx.metadata as Record<string, unknown>)["injected"] = "value";
        }).toThrow();

        return { ok: true };
      },
    });
    commandRegistry.register("enrich", {
      execute: async () => ({ ok: true }),
    });
    commandRegistry.register("notifyApproval", {
      execute: async () => ({ ok: true }),
    });

    const instance = await runtime.createInstance({
      workflowName: "lifecycle-wf",
      metadata: { createdBy: "actor-1", nested: { key: "value" } },
      trigger: { type: "system" },
    });

    await runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "submit",
      trigger: { type: "system" },
    });

    // Verify the metadata was captured and is frozen
    expect(capturedMetadata).toBeDefined();
    expect(Object.isFrozen(capturedMetadata)).toBe(true);
    expect(capturedMetadata!["createdBy"]).toBe("actor-1");

    // Verify nested objects are also frozen
    const nested = capturedMetadata!["nested"] as Record<string, unknown>;
    expect(Object.isFrozen(nested)).toBe(true);

    // Verify the stored instance metadata is unchanged
    const updated = await instanceStore.findByUuid(instance.uuid);
    expect(updated!.metadata).toEqual({
      createdBy: "actor-1",
      nested: { key: "value" },
    });
  });
});
