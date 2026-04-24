import type { CommandResult, WorkflowInstance } from "./runtime.js";

export interface WorkflowInstanceStore {
  /**
   * Persist a newly created workflow instance.
   *
   * Transactional: yes — typically called inside the same transaction as the
   * initial history record append and any onEnter chain writes.
   */
  create(instance: WorkflowInstance): Promise<void>;

  /**
   * Fetch an instance by UUID without acquiring a row lock.
   *
   * Transactional: not required. Safe to call outside a transaction (read-only).
   */
  findByUuid(uuid: string): Promise<WorkflowInstance | null>;

  /**
   * Fetch an instance by UUID and acquire a row lock (`SELECT ... FOR UPDATE`).
   *
   * **Transactional: REQUIRED.** Adapters must throw if called outside an active
   * transaction — a lock acquired without a transaction would be released
   * immediately and defeat the purpose.
   */
  lockByUuid(uuid: string): Promise<WorkflowInstance | null>;

  /**
   * Persist updates to an existing instance's mutable fields (`currentState`,
   * `version`, `context`, `expiresAt`, `lastTransitionAt`, `updatedAt`).
   * `metadata` is immutable and is NOT updated.
   *
   * Uses optimistic locking: adapters must include `version` in the WHERE
   * clause and throw `WorkflowError` if no row is matched (concurrent
   * modification).
   *
   * Transactional: typically inside the same transaction as `lockByUuid`,
   * history appends, and observer-event queuing.
   */
  update(instance: WorkflowInstance): Promise<void>;

  /**
   * Find expired instances whose `expiresAt` is in the past (relative to the
   * `now` parameter — not the database clock).
   *
   * **Transactional: REQUIRED.** Must use `SELECT ... FOR UPDATE SKIP LOCKED`
   * (or equivalent) so multiple workers can safely call this concurrently
   * without processing the same instance twice. The row locks are held for
   * the duration of the caller's transaction.
   */
  findExpired(limit: number, now: Date): Promise<WorkflowInstance[]>;
}

export interface WorkflowHistoryStore {
  /**
   * Append an immutable history record for a state transition.
   * Returns the generated UUID of the new record.
   *
   * Transactional: typically inside the same transaction as the corresponding
   * `update` call so history and instance state are committed atomically.
   */
  append(entry: WorkflowHistoryRecord): Promise<string>;

  /**
   * Retrieve history records for an instance, ordered by creation time
   * descending. Supports pagination via `limit` (default 50) and `offset`
   * (default 0).
   *
   * Transactional: not required. Safe to call outside a transaction
   * (read-only).
   */
  findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]>;
}

export interface WorkflowHistoryRecord {
  workflowInstanceUuid: string;
  fromState: string | null;
  eventName: string;
  toState: string;
  outcome: "success" | "failure";
  errorMessage?: string;
  commandResultsJson: CommandResult[];
  triggerMetadata?: Record<string, unknown>;
}

export interface WorkflowTransactionRunner {
  /**
   * Execute the callback within a database transaction. Commits on success,
   * rolls back on error.
   *
   * The transaction-scoped connection must be propagated (e.g. via
   * `AsyncLocalStorage`) so that store methods called within the callback
   * automatically use the same connection — this is what makes row locks
   * (`FOR UPDATE`) work correctly across `lockByUuid` / `findExpired` and
   * subsequent `update` / `append` calls.
   *
   * If `runInTransaction` is called while a transaction is already active on
   * the current async context, adapters should reuse the existing connection
   * rather than opening a nested transaction.
   */
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}

export interface WorkflowClock {
  now(): Date;
}

export interface WorkflowPersistenceProvider {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
}
