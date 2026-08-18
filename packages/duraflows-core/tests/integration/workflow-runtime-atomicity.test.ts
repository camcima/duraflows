import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { WorkflowError } from "../../src/errors/index.js";
import {
  createInMemoryPersistence,
  type InMemoryHistoryStore,
  type InMemoryInstanceStore,
} from "../helpers/in-memory-persistence.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowClock } from "../../src/types/persistence.js";

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

/**
 * `submit` moves draft -> step1, whose onEnter chain walks step1 -> step2 -> step3.
 * The first hop succeeds and writes instance state plus a history row; the second
 * hop throws. Everything the first hop wrote must disappear with the rollback.
 */
const CHAIN_DEFINITION: WorkflowDefinition = {
  name: "atomicity-chain",
  initialState: "draft",
  states: {
    draft: {
      context: { step: "initial" },
      events: {
        submit: { targetState: "step1" },
      },
    },
    step1: {
      onEnter: {
        targetState: "step2",
        commands: [{ name: "markStep1" }],
      },
    },
    step2: {
      onEnter: {
        targetState: "step3",
        commands: [{ name: "boom" }],
      },
    },
    step3: {},
  },
};

const SIMPLE_DEFINITION: WorkflowDefinition = {
  name: "atomicity-simple",
  initialState: "draft",
  states: {
    draft: {
      context: { step: "initial" },
      events: {
        submit: {
          targetState: "submitted",
          commands: [{ name: "markSubmitted" }],
        },
      },
    },
    submitted: {},
  },
};

const CREATE_DEFINITION: WorkflowDefinition = {
  name: "atomicity-create",
  initialState: "initializing",
  states: {
    initializing: {
      onEnter: {
        targetState: "ready",
        commands: [{ name: "boom" }],
      },
    },
    ready: {},
  },
};

const TIMEOUT_DEFINITION: WorkflowDefinition = {
  name: "atomicity-timeout",
  initialState: "waiting",
  states: {
    waiting: {
      context: { step: "initial" },
      events: {
        expire: {
          targetState: "expired",
          timeout: { afterMinutes: 30 },
          commands: [{ name: "boom" }],
        },
      },
    },
    expired: {},
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WorkflowRuntime transactional atomicity", () => {
  const fixedDate = new Date("2025-06-15T12:00:00.000Z");
  const clock: WorkflowClock = { now: () => fixedDate };

  let runtime: WorkflowRuntime;
  let commandRegistry: InMemoryCommandRegistry;
  let instanceStore: InMemoryInstanceStore;
  let historyStore: InMemoryHistoryStore;
  /** Flips the `boom` command between throwing and succeeding. */
  let boomThrows: boolean;

  beforeEach(() => {
    boomThrows = true;
    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    definitionRegistry.register(CHAIN_DEFINITION);
    definitionRegistry.register(SIMPLE_DEFINITION);
    definitionRegistry.register(CREATE_DEFINITION);
    definitionRegistry.register(TIMEOUT_DEFINITION);

    commandRegistry = new InMemoryCommandRegistry();
    commandRegistry.register("markStep1", {
      execute: async (_subject, ctx) => {
        ctx.context["step"] = "step1-ran";
        return { ok: true };
      },
    });
    commandRegistry.register("markSubmitted", {
      execute: async (_subject, ctx) => {
        ctx.context["step"] = "submitted";
        return { ok: true };
      },
    });
    commandRegistry.register("boom", {
      execute: async () => {
        if (boomThrows) {
          throw new Error("command exploded");
        }
        return { ok: true };
      },
    });

    const persistence = createInMemoryPersistence();
    instanceStore = persistence.instanceStore;
    historyStore = persistence.historyStore;

    runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      ...persistence,
      clock,
    });
  });

  it("commits instance state, context and history when nothing throws (control)", async () => {
    const instance = await runtime.createInstance({ workflowName: "atomicity-simple" });

    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "submit" });

    const stored = await instanceStore.findByUuid(instance.uuid);
    expect(stored!.currentState).toBe("submitted");
    expect(stored!.context).toEqual({ step: "submitted" });
    expect(stored!.version).toBe(1);
    expect(await historyStore.findByInstanceUuid(instance.uuid)).toHaveLength(1);
  });

  it("a command throwing mid-chain leaves instance state, context and history untouched", async () => {
    const instance = await runtime.createInstance({ workflowName: "atomicity-chain" });
    const before = await instanceStore.findByUuid(instance.uuid);

    await expect(runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "submit" })).rejects.toThrow(
      "command exploded",
    );

    const after = await instanceStore.findByUuid(instance.uuid);
    // The first onEnter hop had already advanced the state to step2 and written a
    // history row before the second hop threw — the rollback must undo all of it.
    expect(after!.currentState).toBe("draft");
    expect(after!.context).toEqual({ step: "initial" });
    expect(after!.version).toBe(before!.version);
    expect(after!.lastTransitionAt).toEqual(before!.lastTransitionAt);
    expect(await historyStore.findByInstanceUuid(instance.uuid)).toHaveLength(0);
  });

  it("a rolled-back transition leaves the instance writable by the next event", async () => {
    // Guards against a rollback that reverts the store but leaves the version
    // counter drifting, which would poison every later write.
    const instance = await runtime.createInstance({ workflowName: "atomicity-chain" });

    await expect(runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "submit" })).rejects.toThrow(
      "command exploded",
    );

    boomThrows = false;

    const result = await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "submit" });

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("step3");
  });

  it("createInstance persists nothing when an initial onEnter command throws", async () => {
    const createdUuids: string[] = [];
    const originalCreate = instanceStore.create.bind(instanceStore);
    const createSpy = vi.spyOn(instanceStore, "create").mockImplementation(async (instance) => {
      createdUuids.push(instance.uuid);
      return originalCreate(instance);
    });

    await expect(runtime.createInstance({ workflowName: "atomicity-create" })).rejects.toThrow("command exploded");

    // The row was inserted inside the same transaction, so the rollback must
    // remove it: no half-created instance may survive.
    expect(createdUuids).toHaveLength(1);
    expect(await instanceStore.findByUuid(createdUuids[0])).toBeNull();
    expect(await historyStore.findByInstanceUuid(createdUuids[0])).toHaveLength(0);

    createSpy.mockRestore();
  });

  it("processExpiredWorkflows reports the failure and leaves the instance untouched", async () => {
    const instance = await runtime.createInstance({ workflowName: "atomicity-timeout" });

    // Force the deadline into the past (the clock is fixed at 12:00).
    const armed = await instanceStore.findByUuid(instance.uuid);
    armed!.expiresAt = new Date("2025-06-15T11:00:00.000Z");
    armed!.version++;
    await instanceStore.update(armed!);
    const before = await instanceStore.findByUuid(instance.uuid);

    const result = await runtime.processExpiredWorkflows({ limit: 10 });

    expect(result.processed).toBe(0);
    expect(result.failed).toEqual([{ uuid: instance.uuid, error: "command exploded" }]);

    const after = await instanceStore.findByUuid(instance.uuid);
    expect(after!.currentState).toBe("waiting");
    expect(after!.context).toEqual({ step: "initial" });
    expect(after!.version).toBe(before!.version);
    expect(await historyStore.findByInstanceUuid(instance.uuid)).toHaveLength(0);
  });

  describe("optimistic locking", () => {
    it("the store rejects a write whose expected version no longer matches", async () => {
      const instance = await runtime.createInstance({ workflowName: "atomicity-simple" });
      const stale = await instanceStore.findByUuid(instance.uuid);

      stale!.version++;
      await instanceStore.update(stale!);

      // Re-issuing the same (now stale) version must not silently overwrite.
      await expect(instanceStore.update(stale!)).rejects.toThrow(WorkflowError);
      await expect(instanceStore.update(stale!)).rejects.toThrow(/Optimistic locking failure/);
    });

    it("the store rejects a write for an instance that does not exist", async () => {
      await expect(
        instanceStore.update({
          uuid: "00000000-0000-0000-0000-000000000404",
          workflowName: "atomicity-simple",
          currentState: "draft",
          version: 1,
          definitionVersion: null,
          expiresAt: null,
          lastTransitionAt: fixedDate,
          context: {},
          metadata: {},
          createdAt: fixedDate,
          updatedAt: fixedDate,
        }),
      ).rejects.toThrow(/Optimistic locking failure/);
    });

    it("update never overwrites metadata", async () => {
      const instance = await runtime.createInstance({
        workflowName: "atomicity-simple",
        metadata: { tenant: "alice" },
      });

      const locked = await instanceStore.findByUuid(instance.uuid);
      locked!.version++;
      locked!.metadata = { tenant: "mallory" };
      await instanceStore.update(locked!);

      const stored = await instanceStore.findByUuid(instance.uuid);
      expect(stored!.metadata).toEqual({ tenant: "alice" });
    });

    it("surfaces a version conflict from triggerEvent and rolls the transition back", async () => {
      const instance = await runtime.createInstance({ workflowName: "atomicity-simple" });

      // Another writer commits between our lock and our update, so the version the
      // runtime carries is stale by the time it writes.
      const originalLock = instanceStore.lockByUuid.bind(instanceStore);
      const lockSpy = vi.spyOn(instanceStore, "lockByUuid").mockImplementationOnce(async (uuid: string) => {
        const locked = await originalLock(uuid);
        const concurrent = await originalLock(uuid);
        concurrent!.version++;
        await instanceStore.update(concurrent!);
        return locked;
      });

      await expect(runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "submit" })).rejects.toThrow(
        /Optimistic locking failure/,
      );

      const after = await instanceStore.findByUuid(instance.uuid);
      expect(after!.currentState).toBe("draft");
      expect(after!.context).toEqual({ step: "initial" });
      expect(await historyStore.findByInstanceUuid(instance.uuid)).toHaveLength(0);

      lockSpy.mockRestore();
    });
  });
});
