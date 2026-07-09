import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { WorkflowRuntime } from "../../src/runtime/workflow-runtime.js";
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
// Workflow definition for timeout outcome tests
// ---------------------------------------------------------------------------

const DEFINITION: WorkflowDefinition = {
  name: "timeout-outcome-wf",
  initialState: "waiting",
  states: {
    waiting: {
      events: {
        expire: {
          targetState: "processing",
          timeout: { afterMinutes: 5 },
        },
      },
    },
    processing: {
      onEnter: {
        targetState: "done",
        errorState: "failed",
        commands: [{ name: "finalize" }],
      },
    },
    done: {},
    failed: {},
  },
};

const EVENT_FAILURE_DEFINITION: WorkflowDefinition = {
  name: "timeout-event-failure-wf",
  initialState: "waiting",
  states: {
    waiting: {
      events: {
        expire: {
          targetState: "processed",
          errorState: "failed",
          commands: [{ name: "expireCleanup" }],
          timeout: { afterMinutes: 5 },
        },
      },
    },
    processed: {},
    failed: {},
  },
};

describe("processExpiredWorkflows outcome reporting (AR-03)", () => {
  let now: Date;
  let runtime: WorkflowRuntime;
  let commandRegistry: InMemoryCommandRegistry;

  beforeEach(() => {
    now = new Date("2025-06-15T12:00:00.000Z");
    const definitionRegistry = new InMemoryDefinitionRegistry({
      validator: new WorkflowValidator(),
      compiler: new WorkflowCompiler(),
    });
    definitionRegistry.register(DEFINITION);
    definitionRegistry.register(EVENT_FAILURE_DEFINITION);
    commandRegistry = new InMemoryCommandRegistry();

    runtime = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      instanceStore: new InMemoryInstanceStore(),
      historyStore: new InMemoryHistoryStore(),
      transactionRunner: new InMemoryTransactionRunner(),
      clock: { now: () => now },
    });
  });

  it("reports a business failure when the timeout's on-enter chain routes to the error state", async () => {
    commandRegistry.register("finalize", {
      execute: async () => ({ ok: false, code: "FINALIZE_FAILED" }),
    });

    const instance = await runtime.createInstance({ workflowName: "timeout-outcome-wf" });
    now = new Date("2025-06-15T12:10:00.000Z"); // past the 5-minute deadline

    const result = await runtime.processExpiredWorkflows();

    expect(result.processed).toBe(1);
    expect(result.businessFailed).toEqual([{ uuid: instance.uuid, finalState: "failed" }]);
    expect(result.failed).toEqual([]);
    expect(result.rejected).toBe(0);
  });

  it("reports no business failure when the on-enter chain succeeds", async () => {
    commandRegistry.register("finalize", {
      execute: async () => ({ ok: true }),
    });

    await runtime.createInstance({ workflowName: "timeout-outcome-wf" });
    now = new Date("2025-06-15T12:10:00.000Z");

    const result = await runtime.processExpiredWorkflows();

    expect(result.processed).toBe(1);
    expect(result.businessFailed).toEqual([]);
  });

  it("reports a business failure when the timeout event's own commands fail", async () => {
    commandRegistry.register("expireCleanup", {
      execute: async () => ({ ok: false, code: "CLEANUP_FAILED" }),
    });

    const instance = await runtime.createInstance({ workflowName: "timeout-event-failure-wf" });
    now = new Date("2025-06-15T12:10:00.000Z");

    const result = await runtime.processExpiredWorkflows();

    expect(result.processed).toBe(1);
    expect(result.businessFailed).toEqual([{ uuid: instance.uuid, finalState: "failed" }]);
    expect(result.failed).toEqual([]);
    expect(result.rejected).toBe(0);
  });
});
