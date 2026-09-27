import type { CommandResult, WorkflowInstance } from "./runtime.js";
import type { WorkflowDefinition } from "./definition.js";
import type { AfterCommitCallback } from "../transaction/scoped-transaction-context.js";

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
   * Find instances whose timeout is due, locked for update with skip-locked
   * semantics (`FOR UPDATE SKIP LOCKED`). Due means all of: `expiresAt < now`;
   * not parked (`timeoutRetry?.parkedAt` is null); and no retry scheduled or
   * `timeoutRetry.retryAt < now`. Ordered by when each became due —
   * `timeoutRetry.retryAt` when set, otherwise `expiresAt` — oldest first, so
   * instances whose timeout keeps failing move behind healthy ones. Instances
   * that became due at the same moment come back in no particular order.
   * Adapters must throw if called outside an active transaction.
   *
   * `SKIP LOCKED` only keeps concurrently sweeping workers from blocking on
   * each other's scans; the locks last only as long as the caller's (short)
   * transaction. Cross-worker exclusivity comes from the runtime, which
   * re-locks each instance individually with `lockByUuid` and re-checks that
   * it is still due before processing it — not from this scan.
   */
  findExpired(limit: number, now: Date): Promise<WorkflowInstance[]>;

  /**
   * List instances parked after too many failed timeout attempts
   * (`timeoutRetry.parkedAt` set), oldest-parked first (ties by `uuid`),
   * optionally filtered by workflow name, at most `limit`. A plain read: no
   * transaction required.
   */
  findParkedTimeouts(options: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]>;
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
   * the current async context, adapters SHOULD run the callback in a savepoint
   * on the existing connection: release it on success, and on failure roll
   * back to it and rethrow, so a failed nested call leaves no partial writes
   * and the outer transaction stays usable. An adapter that reuses the
   * connection without a savepoint ("flat" nesting) still conforms but gives
   * nested calls no failure isolation.
   */
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;

  /**
   * Optional. Queues `callback` to run after the transaction active on the
   * current async context commits. It is discarded if its scope, or any
   * savepoint enclosing it, rolls back. Callbacks run in order, outside the
   * finished transaction, and a throwing callback never fails the committed
   * operation. Throws `WorkflowError` when no transaction is active.
   *
   * Runners without it keep the earlier behaviour: the runtime fires observers
   * as soon as its own `runInTransaction` call returns, even when that call
   * was nested in an outer transaction that has not committed yet.
   */
  afterCommit?(callback: AfterCommitCallback): void;
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
