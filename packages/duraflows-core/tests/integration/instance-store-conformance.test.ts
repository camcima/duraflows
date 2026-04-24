/**
 * Conformance suite self-test: verifies that runInstanceStoreConformance works
 * end-to-end by running it against the in-memory store used throughout the
 * core integration tests. This both demonstrates the helper and ensures it
 * stays in sync with the interface.
 */
import { randomUUID } from "node:crypto";
import { runInstanceStoreConformance } from "../../src/testing/index.js";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowHistoryRecord,
  WorkflowTransactionRunner,
} from "../../src/types/persistence.js";
import type { WorkflowInstance } from "../../src/types/runtime.js";

// ---------------------------------------------------------------------------
// Minimal in-memory implementations (same pattern as the other integration
// tests — kept local so the conformance helper itself has no production deps).
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
    const existing = this.instances.get(instance.uuid);
    if (!existing) return;
    // Metadata is immutable — restore it from the stored record
    this.instances.set(instance.uuid, structuredClone({ ...instance, metadata: existing.metadata }));
  }

  async findExpired(limit: number, now: Date): Promise<WorkflowInstance[]> {
    const results: WorkflowInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.expiresAt && inst.expiresAt < now) {
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
// Run the shared conformance suite
// ---------------------------------------------------------------------------

runInstanceStoreConformance("InMemoryInstanceStore (core self-test)", {
  setup: async () => {
    const store = new InMemoryInstanceStore();
    const transactionRunner = new InMemoryTransactionRunner();
    return {
      store,
      transactionRunner,
      teardown: async () => {
        // In-memory: nothing to tear down
      },
    };
  },
});
