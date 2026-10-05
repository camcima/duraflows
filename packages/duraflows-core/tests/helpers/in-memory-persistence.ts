import type { WorkflowExecutionStore, DurableWorkflowExecution } from "../../src/types/durable.js";
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
import { AsyncLocalStorage } from "node:async_hooks";
import { WorkflowError } from "../../src/errors/index.js";
import { runAfterCommitCallbacks, type AfterCommitCallback } from "../../src/transaction/scoped-transaction-context.js";
import type { WorkflowInstance, WorkflowExecutionResult } from "../../src/types/runtime.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type {
  WorkflowHistoryRecord,
  WorkflowHistoryStore,
  WorkflowInstanceStore,
  WorkflowTransactionRunner,
  StoredWorkflowDefinition,
  WorkflowDefinitionStore,
  WorkflowIdempotencyStore,
  WorkflowIdempotencyRecord,
  WorkflowIdempotencyReservation,
} from "../../src/types/persistence.js";

/** A store whose entire state can be captured and put back by the transaction runner. */
export interface SnapshotableStore {
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export class InMemoryInstanceStore implements WorkflowInstanceStore, SnapshotableStore {
  executionStore?: WorkflowExecutionStore;
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

  /**
   * Mirrors the SQL adapters: due means expired (strictly in the past), not
   * parked, and any scheduled retry reached; ordered by retryAt ?? expiresAt.
   */
  async findExpired(
    limit: number,
    now: Date,
    options?: { excludeActiveExecutions?: boolean },
  ): Promise<WorkflowInstance[]> {
    const dueAt = (instance: WorkflowInstance): number =>
      (instance.timeoutRetry?.retryAt ?? instance.expiresAt!).getTime();
    const excluded = new Set<string>();
    if (options?.excludeActiveExecutions)
      for (const instance of this.instances.values()) {
        if (await this.executionStore?.findActive(instance.uuid)) excluded.add(instance.uuid);
      }
    return [...this.instances.values()]
      .filter(
        (instance) =>
          !excluded.has(instance.uuid) &&
          instance.expiresAt !== null &&
          instance.expiresAt < now &&
          !instance.timeoutRetry?.parkedAt &&
          (!instance.timeoutRetry?.retryAt || instance.timeoutRetry.retryAt < now),
      )
      .sort((a, b) => dueAt(a) - dueAt(b))
      .slice(0, limit)
      .map((instance) => structuredClone(instance));
  }

  async findParkedTimeouts(options: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]> {
    return [...this.instances.values()]
      .filter(
        (instance) =>
          instance.timeoutRetry?.parkedAt &&
          (options.workflowName === undefined || instance.workflowName === options.workflowName),
      )
      .sort(
        (a, b) =>
          a.timeoutRetry!.parkedAt!.getTime() - b.timeoutRetry!.parkedAt!.getTime() || a.uuid.localeCompare(b.uuid),
      )
      .slice(0, options.limit)
      .map((instance) => structuredClone(instance));
  }

  async countInstances(options: {
    workflowName: string;
    definitionVersion: number;
    excludeStates: readonly string[];
  }): Promise<number> {
    let count = 0;
    for (const instance of this.instances.values()) {
      if (
        instance.workflowName === options.workflowName &&
        instance.definitionVersion === options.definitionVersion &&
        !options.excludeStates.includes(instance.currentState)
      ) {
        count++;
      }
    }
    return count;
  }

  async findInstanceUuids(options: {
    workflowName: string;
    definitionVersion: number;
    limit: number;
    afterUuid?: string;
    states?: readonly string[];
    excludeStates?: readonly string[];
  }): Promise<string[]> {
    return [...this.instances.values()]
      .filter(
        (instance) =>
          instance.workflowName === options.workflowName &&
          instance.definitionVersion === options.definitionVersion &&
          (options.afterUuid === undefined || instance.uuid > options.afterUuid) &&
          (options.states === undefined || options.states.includes(instance.currentState)) &&
          (options.excludeStates === undefined || !options.excludeStates.includes(instance.currentState)),
      )
      .map((instance) => instance.uuid)
      .sort()
      .slice(0, options.limit);
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
 *
 * Nesting behaves like the SQL adapters' savepoints: a nested call snapshots
 * on entry and restores only its own changes on failure, and its afterCommit
 * callbacks move to the enclosing scope on success or are dropped on failure.
 * The outermost call runs the queued callbacks once it has "committed".
 */
export class InMemoryTransactionRunner implements WorkflowTransactionRunner {
  private readonly scopes = new AsyncLocalStorage<{ callbacks: AfterCommitCallback[] }>();

  constructor(private readonly stores: readonly SnapshotableStore[]) {}

  isTransactionActive(): boolean {
    return this.isActive();
  }

  isActive(): boolean {
    return this.scopes.getStore() !== undefined;
  }

  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    const parent = this.scopes.getStore();
    const scope = { callbacks: [] as AfterCommitCallback[] };
    const snapshots = this.stores.map((store) => store.snapshot());

    let result: T;
    try {
      result = await this.scopes.run(scope, callback);
    } catch (error) {
      this.stores.forEach((store, index) => store.restore(snapshots[index]));
      throw error;
    }

    if (parent) {
      parent.callbacks.push(...scope.callbacks);
    } else {
      await runAfterCommitCallbacks(scope.callbacks);
    }
    return result;
  }

  afterCommit(callback: AfterCommitCallback): void {
    const scope = this.scopes.getStore();
    if (!scope) {
      throw new WorkflowError("afterCommit requires an active transaction");
    }
    scope.callbacks.push(callback);
  }
}

/**
 * Builds a matched instance store, history store and rollback-capable
 * transaction runner. This is the wiring every core integration suite wants:
 * the runner is already bound to both stores, so a throw anywhere inside a
 * transaction reverts instance state and history together.
 */
export function createInMemoryPersistence(options: { idempotency?: boolean; durableExecution?: boolean } = {}): {
  instanceStore: InMemoryInstanceStore;
  historyStore: InMemoryHistoryStore;
  transactionRunner: InMemoryTransactionRunner;
  idempotencyStore?: InMemoryIdempotencyStore;
  executionStore?: InMemoryExecutionStore;
} {
  const instanceStore = new InMemoryInstanceStore();
  const historyStore = new InMemoryHistoryStore();
  const idempotencyStore = new InMemoryIdempotencyStore(() => transactionRunner.isActive());
  const executionStore = new InMemoryExecutionStore(() => transactionRunner.isActive());
  if (options.durableExecution) instanceStore.executionStore = executionStore;
  const transactionRunner = new InMemoryTransactionRunner([
    instanceStore,
    historyStore,
    ...(options.idempotency ? [idempotencyStore] : []),
    ...(options.durableExecution ? [executionStore] : []),
  ]);
  return {
    instanceStore,
    historyStore,
    transactionRunner,
    ...(options.idempotency ? { idempotencyStore } : {}),
    ...(options.durableExecution ? { executionStore } : {}),
  };
}

export class InMemoryIdempotencyStore implements WorkflowIdempotencyStore, SnapshotableStore {
  private records = new Map<string, WorkflowIdempotencyRecord>();
  constructor(private readonly isActive: () => boolean) {}

  private identity(uuid: string, key: string): string {
    if (!this.isActive()) throw new WorkflowError("WorkflowIdempotencyStore requires an active transaction");
    return JSON.stringify([uuid, key]);
  }

  async find(uuid: string, key: string): Promise<WorkflowIdempotencyRecord | null> {
    const record = this.records.get(this.identity(uuid, key));
    return record ? structuredClone(record) : null;
  }

  async reserve(input: WorkflowIdempotencyReservation): Promise<void> {
    const key = this.identity(input.workflowInstanceUuid, input.key);
    if (this.records.has(key)) throw new WorkflowError("Idempotency reservation already exists");
    this.records.set(key, { ...input, result: null, createdAt: new Date() });
  }

  async complete(uuid: string, key: string, result: WorkflowExecutionResult): Promise<void> {
    const record = this.records.get(this.identity(uuid, key));
    if (!record || record.result !== null)
      throw new WorkflowError("Idempotency reservation is missing or already completed");
    record.result = JSON.parse(JSON.stringify(result)) as WorkflowExecutionResult;
  }

  snapshot(): unknown {
    return structuredClone(this.records);
  }
  restore(snapshot: unknown): void {
    this.records = snapshot as Map<string, WorkflowIdempotencyRecord>;
  }
}

/**
 * A definition-snapshot store double. `ensure()` is insert-if-absent — a
 * second call for the same `(workflowName, version)` returns the original row
 * untouched, which is what lets the runtime's bump guard detect a content
 * mismatch by comparing hashes.
 */
export class InMemoryDefinitionStore implements WorkflowDefinitionStore {
  private readonly rows = new Map<string, StoredWorkflowDefinition>();

  async ensure(record: {
    workflowName: string;
    version: number;
    contentHash: string;
    definitionJson: WorkflowDefinition;
  }): Promise<StoredWorkflowDefinition> {
    const key = `${record.workflowName}@${record.version}`;
    const existing = this.rows.get(key);
    if (existing) return structuredClone(existing);
    const stored: StoredWorkflowDefinition = {
      workflowName: record.workflowName,
      version: record.version,
      contentHash: record.contentHash,
      definitionJson: structuredClone(record.definitionJson),
      registeredAt: new Date(),
    };
    this.rows.set(key, stored);
    return structuredClone(stored);
  }

  async findByNameAndVersion(workflowName: string, version: number): Promise<StoredWorkflowDefinition | null> {
    const row = this.rows.get(`${workflowName}@${version}`);
    return row ? structuredClone(row) : null;
  }

  async listVersions(workflowName: string): Promise<StoredWorkflowDefinition[]> {
    return [...this.rows.values()]
      .filter((row) => row.workflowName === workflowName)
      .sort((a, b) => a.version - b.version)
      .map((row) => structuredClone(row));
  }
}

export class InMemoryExecutionStore implements WorkflowExecutionStore, SnapshotableStore {
  private records = new Map<string, DurableWorkflowExecution>();
  constructor(private readonly isActive: () => boolean) {}
  async create(e: DurableWorkflowExecution): Promise<void> {
    if (!this.isActive()) throw new WorkflowError("transaction required");
    if (
      this.records.has(e.uuid) ||
      (await this.findByKey(e.workflowInstanceUuid, e.idempotencyKey)) ||
      (await this.findActive(e.workflowInstanceUuid))
    )
      throw new WorkflowError("execution exists");
    this.records.set(e.uuid, JSON.parse(JSON.stringify(e)) as DurableWorkflowExecution);
  }
  async update(e: DurableWorkflowExecution): Promise<void> {
    if (!this.isActive()) throw new WorkflowError("transaction required");
    if (this.records.get(e.uuid)?.revision !== e.revision - 1) throw new WorkflowError("revision conflict");
    this.records.set(e.uuid, JSON.parse(JSON.stringify(e)) as DurableWorkflowExecution);
  }
  async findByUuid(uuid: string): Promise<DurableWorkflowExecution | null> {
    return structuredClone(this.records.get(uuid) ?? null);
  }
  async findByKey(uuid: string, key: string): Promise<DurableWorkflowExecution | null> {
    return structuredClone(
      [...this.records.values()].find((e) => e.workflowInstanceUuid === uuid && e.idempotencyKey === key) ?? null,
    );
  }
  async findActive(uuid: string): Promise<DurableWorkflowExecution | null> {
    return structuredClone(
      [...this.records.values()].find(
        (e) => e.workflowInstanceUuid === uuid && ["pending", "running", "parked"].includes(e.status),
      ) ?? null,
    );
  }
  async findDue(limit: number, now: Date): Promise<DurableWorkflowExecution[]> {
    return structuredClone(
      [...this.records.values()]
        .filter(
          (e) =>
            ["pending", "running"].includes(e.status) &&
            new Date(e.availableAt) <= now &&
            (e.leaseUntil === null || new Date(e.leaseUntil) <= now),
        )
        .slice(0, limit),
    );
  }
  snapshot(): unknown {
    return structuredClone(this.records);
  }
  restore(snapshot: unknown): void {
    this.records = snapshot as Map<string, DurableWorkflowExecution>;
  }
}
