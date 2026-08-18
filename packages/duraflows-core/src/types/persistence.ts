import type { CommandResult, WorkflowInstance } from "./runtime.js";
import type { WorkflowDefinition } from "./definition.js";

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
   * Uses optimistic locking. The runtime increments `instance.version`
   * BEFORE calling this method, so the passed `version` is the NEW value.
   * Adapters must match on the previous version in the WHERE clause
   * (`WHERE version = instance.version - 1`), SET `version` to
   * `instance.version`, and throw `WorkflowError` if no row is matched
   * (concurrent modification).
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
   * (or equivalent) so concurrently sweeping workers skip rows another
   * worker is currently scanning. The locks last only as long as the
   * caller's transaction — the runtime intentionally runs this in a short
   * transaction and re-locks each instance individually (via `lockByUuid`
   * plus an `expiresAt` re-check) before processing, so cross-worker
   * exclusivity comes from that re-lock, not from this scan.
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
  outcome: "success" | "failure" | "guard-rejected";
  errorMessage?: string;
  rejectedBy?: string;
  commandResultsJson: CommandResult[];
  triggerMetadata?: Record<string, unknown>;
  /** The definition version that governed this transition. Absent/null on legacy rows. */
  definitionVersion?: number | null;
  /**
   * When this transition was recorded. Populated by the store on read;
   * ignored on write — the database assigns it.
   *
   * Caveat: every history row written inside the same database transaction
   * (an event plus its entire `onEnter` chain) shares an identical
   * `createdAt`, and stores tiebreak ties with a random UUID by default, so
   * this field must not be used to reconstruct the order of steps within one
   * multi-hop transition — only to know roughly when the transition happened.
   * On the pg adapter, `generateMigrationSql({ uuidStrategy: "uuidv7" })`
   * (PostgreSQL 18+) makes that tiebreak monotonic instead of random — see
   * docs/persistence.md.
   */
  createdAt?: Date;
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

export interface StoredWorkflowDefinition {
  workflowName: string;
  version: number;
  contentHash: string;
  definitionJson: WorkflowDefinition;
  registeredAt: Date;
}

export interface WorkflowDefinitionStore {
  /**
   * Insert the definition snapshot if `(workflowName, version)` is absent,
   * then return the stored row — the pre-existing one or the newly created
   * one. Must be atomic under concurrent callers (e.g. `INSERT ... ON
   * CONFLICT DO NOTHING` followed by a re-select) and must NEVER overwrite
   * an existing row.
   *
   * Transactional: not required.
   */
  ensure(record: {
    workflowName: string;
    version: number;
    contentHash: string;
    definitionJson: WorkflowDefinition;
  }): Promise<StoredWorkflowDefinition>;

  /**
   * Fetch a stored definition snapshot.
   *
   * Transactional: not required (read-only).
   */
  findByNameAndVersion(workflowName: string, version: number): Promise<StoredWorkflowDefinition | null>;
}

export interface WorkflowPersistenceProvider {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
  /**
   * Optional so existing custom providers keep compiling; the bundled pg and
   * kysely providers always supply it. Definition-versioning features are
   * inert without it.
   */
  definitionStore?: WorkflowDefinitionStore;
}
