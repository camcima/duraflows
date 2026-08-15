/**
 * Shared in-memory persistence doubles for the core integration suites.
 *
 * These are deliberately closer to a real adapter than a plain `Map` wrapper:
 *
 * - `InMemoryInstanceStore.update()` enforces the optimistic-locking and
 *   metadata-immutability contract documented on `WorkflowInstanceStore`.
 * - `InMemoryTransactionRunner` really rolls back — it snapshots every store it
 *   is given on entry and restores those snapshots when the callback throws.
 *
 * Without the second point, rollback-on-partial-failure — the durability
 * promise the whole runtime is built on — would have no core-level coverage.
 */
import { randomUUID } from "node:crypto";
import { WorkflowError } from "../../src/errors/index.js";
import type { WorkflowInstance } from "../../src/types/runtime.js";
import type {
  WorkflowHistoryRecord,
  WorkflowHistoryStore,
  WorkflowInstanceStore,
  WorkflowTransactionRunner,
} from "../../src/types/persistence.js";

/** A store whose entire state can be captured and put back by the transaction runner. */
export interface SnapshotableStore {
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export class InMemoryInstanceStore implements WorkflowInstanceStore, SnapshotableStore {
  private instances = new Map<string, WorkflowInstance>();

  async create(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.uuid, structuredClone(instance));
  }

  async findByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const instance = this.instances.get(uuid);
    return instance ? structuredClone(instance) : null;
  }

  async lockByUuid(uuid: string): Promise<WorkflowInstance | null> {
    return this.findByUuid(uuid);
  }

  /**
   * Optimistic locking, exactly as the SQL adapters implement it: the runtime
   * pre-increments `version`, so the stored record must still sit at
   * `instance.version - 1` for the write to apply. `metadata` is immutable and
   * is carried over from the stored record.
   */
  async update(instance: WorkflowInstance): Promise<void> {
    const existing = this.instances.get(instance.uuid);
    const expectedVersion = instance.version - 1;
    if (!existing || existing.version !== expectedVersion) {
      throw new WorkflowError(
        `Optimistic locking failure: workflow instance "${instance.uuid}" was modified concurrently (expected version ${expectedVersion})`,
      );
    }
    this.instances.set(instance.uuid, structuredClone({ ...instance, metadata: existing.metadata }));
  }

  /** Mirrors the adapters' `expires_at < now` predicate (strictly in the past). */
  async findExpired(limit: number, now: Date): Promise<WorkflowInstance[]> {
    const results: WorkflowInstance[] = [];
    for (const instance of this.instances.values()) {
      if (instance.expiresAt && instance.expiresAt < now) {
        results.push(structuredClone(instance));
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  snapshot(): unknown {
    return new Map([...this.instances.entries()].map(([uuid, instance]) => [uuid, structuredClone(instance)]));
  }

  restore(snapshot: unknown): void {
    this.instances = snapshot as Map<string, WorkflowInstance>;
  }
}

export class InMemoryHistoryStore implements WorkflowHistoryStore, SnapshotableStore {
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
    // Records are appended, never mutated in place, so a shallow copy is enough.
    return [...this.records];
  }

  restore(snapshot: unknown): void {
    this.records = snapshot as Array<WorkflowHistoryRecord & { uuid: string }>;
  }
}

/**
 * A transaction runner that actually simulates a transaction: it snapshots
 * every store it was given before running the callback and restores those
 * snapshots if the callback throws, so a partial failure leaves no trace.
 */
export class InMemoryTransactionRunner implements WorkflowTransactionRunner {
  private depth = 0;

  constructor(private readonly stores: readonly SnapshotableStore[]) {}

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    // Nesting is flat, exactly like the SQL adapters: an inner call joins the
    // outer transaction rather than opening a savepoint, so only the outermost
    // scope can roll anything back.
    if (this.depth > 0) {
      return callback();
    }

    const snapshots = this.stores.map((store) => store.snapshot());
    this.depth++;
    try {
      return await callback();
    } catch (error) {
      this.stores.forEach((store, index) => store.restore(snapshots[index]));
      throw error;
    } finally {
      this.depth--;
    }
  }
}

/**
 * Builds a matched instance store, history store and rollback-capable
 * transaction runner. This is the wiring every core integration suite wants:
 * the runner is already bound to both stores, so a throw anywhere inside a
 * transaction reverts instance state and history together.
 */
export function createInMemoryPersistence(): {
  instanceStore: InMemoryInstanceStore;
  historyStore: InMemoryHistoryStore;
  transactionRunner: InMemoryTransactionRunner;
} {
  const instanceStore = new InMemoryInstanceStore();
  const historyStore = new InMemoryHistoryStore();
  const transactionRunner = new InMemoryTransactionRunner([instanceStore, historyStore]);
  return { instanceStore, historyStore, transactionRunner };
}
