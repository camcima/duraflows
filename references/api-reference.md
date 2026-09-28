# duraflows API Reference

> Corresponds to duraflows **v1.1.0**. For the latest, check the source at [github.com/camcima/duraflows](https://github.com/camcima/duraflows).

---

## Package Exports

### @duraflows/core

**Types:**
`WorkflowDefinition`, `WorkflowStateDefinition`, `WorkflowEventDefinition`, `WorkflowOnEnterDefinition`, `WorkflowCommandRef`, `WorkflowGuardRef`, `WorkflowTimeoutDefinition`, `WorkflowCommand`, `WorkflowGuard`, `CommandResult`, `WorkflowExecutionContext`, `WorkflowInstance`, `WorkflowTimeoutRetry` (v6.0.0), `WorkflowTimeoutRetryOptions` (v6.0.0), `WorkflowExecutionResult`, `OnEnterChainResult`, `OnEnterHopResult`, `AvailableWorkflowEvent`, `WorkflowHistoryRecord`, `CreateWorkflowInstanceInput`, `TriggerWorkflowEventInput`, `ProcessExpiredWorkflowsInput`, `ProcessExpiredWorkflowsResult`, `FindParkedTimeoutsInput` (v6.0.0), `GetAvailableEventsInput`, `WorkflowInstanceStore`, `WorkflowHistoryStore`, `WorkflowTransactionRunner`, `WorkflowDefinitionStore` (v5.0.0), `StoredWorkflowDefinition` (v5.0.0), `DefinitionVersionSummary` (v7.0.0), `MigrateInstancesInput` (v7.1.0), `MigrateInstancesResult` (v7.1.0), `WorkflowClock`, `WorkflowPersistenceProvider`, `WorkflowDefinitionRegistry`, `WorkflowCommandRegistry`, `WorkflowGuardRegistry`, `WorkflowObserver`, `StateEnterEvent`, `ObserverErrorHandler`, `WorkflowRuntimeOptions`

**Classes:**
`WorkflowRuntime`, `WorkflowHandle`, `WorkflowValidator`, `WorkflowCompiler`, `CommandExecutor`, `EventExecutor`, `OnEnterExecutor`, `TimeoutResolver`, `InMemoryDefinitionRegistry`, `InMemoryCommandRegistry`, `InMemoryGuardRegistry`, `ObserverRegistry`

**Functions:**
`toMermaidDiagram(definition, options?)` — renders a Mermaid flowchart for a `WorkflowDefinition` (added v0.3.0).

**Subpath export — `@duraflows/core/testing`:**
`runInstanceStoreConformance(factory)` — shared conformance suite. Adapter authors run this against their `WorkflowInstanceStore` to verify the persistence contract (locking, optimistic concurrency, expiration).

**Errors:**
`WorkflowError`, `WorkflowDefinitionError`, `InvalidArgumentError`, `WorkflowInstanceNotFoundError`, `InvalidEventError`, `IncompatibleDefinitionError` (v7.0.0), `CommandFailureError`, `OnEnterDepthExceededError`

### @duraflows/pg

`pgWorkflowProviders(pool)`, `generateMigrationSql(options?)`, `PgWorkflowInstanceStore`, `PgWorkflowHistoryStore`, `PgWorkflowDefinitionStore` (v5.0.0), `PgTransactionRunner`, `PgTransactionContext`

### @duraflows/kysely

`kyselyWorkflowProviders(db)`, `KyselyWorkflowInstanceStore`, `KyselyWorkflowHistoryStore`, `KyselyWorkflowDefinitionStore` (v5.0.0), `KyselyTransactionRunner`, `KyselyTransactionContext`, plus `WorkflowDatabase` table type definitions. Added in v0.4.0 — alternative to `@duraflows/pg` for projects already using Kysely.

### @duraflows/nestjs

`WorkflowModule`, `WorkflowService`, `WorkflowTimeoutService`, `WorkflowCommand` (decorator), `WORKFLOW_RUNTIME`, `WORKFLOW_INSTANCE_STORE`, `WORKFLOW_HISTORY_STORE`, `WORKFLOW_COMMAND_REGISTRY`, `WORKFLOW_DEFINITION_REGISTRY`, `WORKFLOW_GUARD_REGISTRY` (v1.1.0), `WORKFLOW_TRANSACTION_RUNNER`, `WORKFLOW_CLOCK`. Also re-exports the entire `@duraflows/core` public API (including observer + guard types) so apps can import everything from a single package.

---

## Definition Types

### WorkflowDefinition

```ts
interface WorkflowDefinition {
  name: string; // unique identifier
  version?: number; // positive safe integer, defaults to 1
  versionPolicy?: "pinned" | "latest"; // v7.0.0: defaults to "pinned"; excluded from the content hash
  initialState: string; // must exist in states
  states: Record<string, WorkflowStateDefinition>; // at least one state required
}
```

**`versionPolicy` (v7.0.0):** `"pinned"` (default) -- each instance executes the version it was stamped with, loaded from the `definitionStore` when it differs from the latest registered version. `"latest"` -- every instance of the workflow executes the currently registered definition; an instance whose current state that definition lacks throws `IncompatibleDefinitionError`. **The latest registered definition's `versionPolicy` governs every instance of the workflow** -- it is not a per-instance setting. Requires a `definitionStore`; without one, pinning is inert regardless of `versionPolicy`.

### WorkflowStateDefinition

```ts
interface WorkflowStateDefinition {
  context?: Record<string, unknown>; // merged into instance context on entry
  events?: Record<string, WorkflowEventDefinition>; // available events (none = terminal state)
  onEnter?: WorkflowOnEnterDefinition; // auto-fire on entry
  metadata?: Record<string, unknown>; // arbitrary state metadata
}
```

### WorkflowEventDefinition

```ts
interface WorkflowEventDefinition {
  guard?: WorkflowGuardRef; // v1.1.0: precondition evaluated BEFORE commands
  targetState?: string; // state on success (omit for command-only events)
  errorState?: string; // state on command failure
  commands?: WorkflowCommandRef[]; // sequential, fail-fast (best-effort commands continue on failure)
  timeout?: WorkflowTimeoutDefinition; // auto-trigger after duration
  metadata?: Record<string, unknown>;
}
```

**v1.0.0:** `targetState` is now optional. An event must define **at least one** of `targetState`, `errorState`, or `commands` (an empty event is a definition error). Patterns this enables:

- **Command-only event** (no `targetState`): runs commands as side effects, stays in current state. Still appends a history record. The observer fires as a self-transition with `fromState === toState`.
- **Failure-only event**: only an `errorState` and `commands`, no `targetState`. Useful when the event exists purely to trap a failure and route to recovery.

**v1.1.0:** Optional `guard` runs before any commands. If it returns `false`, the event short-circuits with `outcome: "guard-rejected"`, no commands run, no state change, and a history row with `rejectedBy: "<guard-name>"` is appended. `errorState` is for **command** failures only — it does not catch guard rejections. See [Guards](#guards-v110).

### WorkflowOnEnterDefinition

```ts
interface WorkflowOnEnterDefinition {
  targetState?: string; // state on success
  errorState?: string; // state on command failure
  commands?: WorkflowCommandRef[]; // sequential, fail-fast
  metadata?: Record<string, unknown>;
}
```

### WorkflowCommandRef

```ts
interface WorkflowCommandRef {
  name: string; // maps to registered WorkflowCommand
  metadata?: Record<string, unknown>; // per-invocation metadata (v1.0.0: exposed to handler via ctx.commandMetadata)
}
```

**v1.0.0:** the `metadata` field is exposed to the command handler via `WorkflowExecutionContext.commandMetadata` — deep-cloned and deep-frozen per command so each ref in a chain sees its own metadata, never a sibling's. Use this to drive one handler with different parameters from many call sites (channel/template/vendor selection, A/B variants, etc.).

### WorkflowGuardRef (v1.1.0)

```ts
interface WorkflowGuardRef {
  name: string; // resolved against the WorkflowGuardRegistry
  metadata?: Record<string, unknown>; // exposed to the guard via ctx.commandMetadata
}
```

The guard's `metadata` reaches the handler through the same `WorkflowExecutionContext.commandMetadata` slot used by commands — deep-cloned and deep-frozen for the duration of the evaluation. Use this for guard parameters like `{ maxDays: 30 }` or `{ minTier: "gold" }` so one `WorkflowGuard` implementation can serve many call sites.

### WorkflowTimeoutDefinition

```ts
interface WorkflowTimeoutDefinition {
  afterMinutes?: number; // * 60,000 ms
  afterHours?: number; // * 3,600,000 ms
  afterDays?: number; // * 86,400,000 ms
}
```

All fields are **additive**. At least one must be defined. All must be positive. At most one timeout event per state.

---

## Runtime Types

### WorkflowCommand

```ts
interface WorkflowCommand<TSubject = unknown> {
  readonly bestEffort?: boolean; // v1.0.0: fire-and-forget side effect
  execute(subject: TSubject, context: WorkflowExecutionContext): Promise<CommandResult> | CommandResult;
}
```

**`bestEffort` semantics (v1.0.0):**

| Outcome                 | Mandatory command (`bestEffort` undefined / false) | `bestEffort: true`                                                                                            |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Returns `{ ok: true }`  | Chain continues                                    | Chain continues                                                                                               |
| Returns `{ ok: false }` | Chain stops; routes to `errorState` or throws      | Result recorded; chain continues; aggregate `outcome` stays `success`                                         |
| Throws                  | Exception propagates; transaction rolls back       | Caught, converted to `{ ok: false, code: "BEST_EFFORT_THROWN", error: { name, message, stack? } }`; continues |

A best-effort `ok: false` does **not** taint the aggregate `outcome` of a `triggerEvent` or onEnter chain — only mandatory failures do. Use `bestEffort` for non-critical side effects (notifications, metrics, analytics) where a flaky provider should not block business state.

### CommandResult

```ts
interface CommandResult {
  ok: boolean; // true = success, false = controlled failure
  code?: string; // machine-readable (e.g., "PAYMENT_CHARGED")
  message?: string; // human-readable description
  metadata?: Record<string, unknown>; // additional data
  error?: unknown; // error details (for failures; serializable for bestEffort throws)
}
```

### WorkflowExecutionContext

```ts
interface WorkflowExecutionContext {
  triggerMetadata: Readonly<Record<string, unknown>>; // frozen; who/what triggered
  now: Date; // from injected WorkflowClock
  context: Record<string, unknown>; // MUTABLE working memory
  metadata: Readonly<Record<string, unknown>>; // frozen; immutable identity
  readonly commandMetadata: Readonly<Record<string, unknown>>; // v1.0.0: per-command metadata from WorkflowCommandRef.metadata
  readonly fromState: string | null; // v1.0.0: state being left (null on initial create)
  readonly toState: string; // v1.0.0: state being entered for this command
  readonly transitionUuid: string; // v1.0.0: shared with the matching observer event
}
```

**v1.0.0 transition fields:**

- `commandMetadata` — deep-cloned + frozen copy of the invoking `WorkflowCommandRef.metadata` (or `{}`). Each command in a chain sees its own.
- `fromState` / `toState` — useful for structured logging without re-querying the instance.
- `transitionUuid` — UUID identifying a state entry. Shared by all commands running on entry to a given state (event commands + onEnter commands for that hop) and by the matching `StateEnterEvent`. A fresh UUID is minted when the chain transitions to a new state.

### WorkflowInstance

```ts
interface WorkflowInstance {
  uuid: string;
  workflowName: string;
  currentState: string;
  version: number; // incremented on each transition
  definitionVersion: number | null; // v5.0.0: definition version governing the instance; null on legacy rows
  expiresAt: Date | null; // timeout deadline
  timeoutRetry: WorkflowTimeoutRetry | null; // v6.0.0: failed-timeout retry state; null = no failure since the last success
  lastTransitionAt: Date;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowTimeoutRetry {
  attempts: number; // consecutive failed timeout attempts since the last success (>= 1)
  lastError: string; // most recent failure's message, truncated to 2000 characters, NUL replaced by U+FFFD
  retryAt: Date | null; // when the sweep may try again; null once parked
  parkedAt: Date | null; // when parked after maxAttempts failures; null while retrying
}
```

`timeoutRetry` is cleared by any successful transition (including a manual `triggerEvent()`) and by `rearmTimeout()`. `lastError` carries the raw error message, which may include internal details.

**v7.0.0 -- `definitionVersion` now governs execution, not just provenance.** `triggerEvent()`, `processExpiredWorkflows()`'s sweep, and `getAvailableEvents()` resolve the definition stamped on `definitionVersion` (loading it from the `definitionStore` when it differs from the latest registered version), rather than always the currently registered one. `createInstance()` is unaffected -- new instances always start on the latest version. See [Definition versioning (v7.0.0)](#definition-versioning-v700).

### WorkflowExecutionResult

```ts
interface WorkflowExecutionResult {
  outcome: "success" | "failure" | "guard-rejected"; // v1.1.0: added "guard-rejected"
  fromState: string;
  toState: string; // final state after any onEnter chain (== fromState when guard-rejected)
  commandResults: CommandResult[]; // empty when guard-rejected
  historyUuid: string;
  rejectedBy?: string; // v1.1.0: the guard ref name when outcome === "guard-rejected"
}
```

`outcome` (v1.0.0) is aggregated across both the event execution and the subsequent onEnter chain:

```
outcome = eventResult.outcome === "failure" || onEnterChain.outcome === "failure"
  ? "failure"
  : "success"
```

A best-effort command returning `ok: false` does **not** taint `outcome`. A mandatory command routing to `errorState` surfaces as `outcome: "failure"` even if subsequent onEnter hops succeed.

**v1.1.0 — `"guard-rejected"`:** when an event's guard returns `false`, the runtime short-circuits before commands or state change. `toState === fromState`, `commandResults` is empty, `rejectedBy` is the declared `eventDef.guard.name` (the workflow-definition ref name, not the registered guard's `.name` property — these can diverge with custom registries). Guard rejections are **not** routed to `errorState` — `errorState` is for command failures.

### OnEnterChainResult

```ts
interface OnEnterChainResult {
  finalState: string;
  outcome: "success" | "failure"; // v1.0.0: "failure" if ANY hop routed to errorState
  hops: OnEnterHopResult[];
}

interface OnEnterHopResult {
  fromState: string;
  toState: string;
  transitionUuid: string;
  outcome: "success" | "failure";
  commandResults: CommandResult[];
}
```

Prefer inspecting `outcome` directly over examining the last hop or last command result.

### AvailableWorkflowEvent

```ts
interface AvailableWorkflowEvent {
  eventName: string;
  targetState?: string;
  errorState?: string;
  hasCommands: boolean;
  hasTimeout: boolean;
  metadata?: Record<string, unknown>;
}
```

### WorkflowHistoryRecord

```ts
interface WorkflowHistoryRecord {
  workflowInstanceUuid: string;
  fromState: string | null; // null for creation
  eventName: string; // "onEnter" for auto-transitions
  toState: string; // == fromState for guard-rejected and command-only events
  outcome: "success" | "failure" | "guard-rejected"; // v1.1.0: added "guard-rejected"
  errorMessage?: string;
  rejectedBy?: string; // v1.1.0: guard ref name when outcome === "guard-rejected"
  commandResultsJson: CommandResult[]; // field name ends in `Json` — distinct from WorkflowExecutionResult.commandResults
  triggerMetadata?: Record<string, unknown>;
  createdAt?: Date; // v5.0.0: populated by the store on read; ignored on write (the database assigns it)
}
```

The exported type intentionally omits the row's `uuid` — that's a storage concern, returned out-of-band by `WorkflowHistoryStore.append` (which returns a generated UUID) and not part of the read shape adapter authors implement against. `createdAt` tells you roughly when a transition happened, but rows written inside the same database transaction (an event plus its entire `onEnter` chain) share an identical value, so it must not be used to order steps within one multi-hop transition.

**v1.1.0:** a guard rejection writes a row with `outcome: "guard-rejected"`, `rejectedBy: "<guard-name>"`, `fromState === toState`, and an empty `commandResultsJson` array. Both the underlying CHECK constraint and the `rejected_by` column are added by migration `003_event_guards.sql` in `@duraflows/pg`; custom adapters must persist `rejectedBy` on append and map `null → undefined` on read.

---

## Input Types

### CreateWorkflowInstanceInput

```ts
interface CreateWorkflowInstanceInput {
  workflowName: string; // must match registered definition
  context?: Record<string, unknown>; // initial mutable context
  metadata?: Record<string, unknown>; // immutable identity labels
  triggerMetadata?: Record<string, unknown>; // who/what created it
}
```

### TriggerWorkflowEventInput

```ts
interface TriggerWorkflowEventInput {
  workflowInstanceUuid: string;
  eventName: string; // must exist on current state
  subject?: unknown; // domain entity passed to commands
  triggerMetadata?: Record<string, unknown>; // who/what triggered
}
```

### ProcessExpiredWorkflowsInput

```ts
interface ProcessExpiredWorkflowsInput {
  limit?: number; // default: 100
}
```

### ProcessExpiredWorkflowsResult

```ts
interface ProcessExpiredWorkflowsResult {
  processed: number; // timeout fired and the instance transitioned
  rejected: number; // v1.1.0: timeout fired but a guard rejected — instance stays in place
  businessFailed: Array<{ uuid: string; finalState: string }>; // subset of processed whose event commands or on-enter chain failed
  failed: Array<{ uuid: string; error: string; attempts?: number; retryAt?: Date | null }>; // infrastructure failures (transaction rolled back)
  parked: Array<{ uuid: string; error: string }>; // v6.0.0: subset of failed parked by this sweep
}
```

**v6.0.0 — retries and parking:** each `failed` instance's failure is recorded on its `timeoutRetry` in a second small transaction. When recording succeeded, `attempts` is the consecutive failure count and `retryAt` the next retry (`null` when this failure parked the instance); the sweep skips the instance until then. After `timeoutRetry.maxAttempts` consecutive failures the instance is parked, listed in `parked`, and no longer swept until `rearmTimeout()` clears it. Failed attempts write no history rows.

**v1.1.0 — `rejected`:** when a timeout-driven event has a guard that returns `false`, the runtime additionally clears `expiresAt` so the next sweep won't re-pick the instance. The history row is still appended with `outcome: "guard-rejected"`. Track `rejected` separately from `processed` so observability dashboards don't conflate "timeout fired and progressed" with "timeout fired and was held back."

### FindParkedTimeoutsInput (v6.0.0)

```ts
interface FindParkedTimeoutsInput {
  limit?: number; // default: 100
  workflowName?: string; // only instances of this workflow
}
```

### GetAvailableEventsInput

```ts
interface GetAvailableEventsInput {
  workflowInstanceUuid: string;
}
```

---

## Persistence Interfaces

### WorkflowInstanceStore

```ts
interface WorkflowInstanceStore {
  create(instance: WorkflowInstance): Promise<void>;
  findByUuid(uuid: string): Promise<WorkflowInstance | null>;
  lockByUuid(uuid: string): Promise<WorkflowInstance | null>; // FOR UPDATE (REQUIRES active transaction)
  update(instance: WorkflowInstance): Promise<void>; // optimistic locking (checks version); MUST NOT update metadata
  findExpired(limit: number, now: Date): Promise<WorkflowInstance[]>; // due instances, FOR UPDATE SKIP LOCKED (REQUIRES active transaction)
  findParkedTimeouts(options: { limit: number; workflowName?: string }): Promise<WorkflowInstance[]>; // v6.0.0: parked only; no transaction required
  countInstances(options: {
    workflowName: string;
    definitionVersion: number;
    excludeStates: readonly string[];
  }): Promise<number>; // v7.0.0: required on every adapter; no transaction required
  findInstanceUuids?(options: {
    workflowName: string;
    definitionVersion: number;
    limit: number;
    afterUuid?: string;
  }): Promise<string[]>; // v7.1.0: optional; no transaction required
}
```

**v1.0.0 contract notes** (also enforced by `runInstanceStoreConformance`):

- `lockByUuid` / `findExpired` MUST throw if called outside a transaction.
- `update` MUST NOT modify `metadata_json` — metadata is write-once after `create()`.
- `findExpired` MUST honor `SKIP LOCKED` semantics (or the platform equivalent) so concurrent workers don't block each other. `SKIP LOCKED` alone doesn't prevent double processing: the runtime re-locks each instance with `lockByUuid` and re-checks that it is still due before processing it.

**v6.0.0 contract notes:**

- `create` / `update` MUST persist `timeoutRetry` (see [Database Schema](#database-schema) for the column mapping).
- `findExpired` returns only **due** instances: `expires_at < now AND timeout_parked_at IS NULL AND (timeout_retry_at IS NULL OR timeout_retry_at < now)`, ordered by `coalesce(timeout_retry_at, expires_at)`, oldest first. SQL adapters should also add the redundant `coalesce(timeout_retry_at, expires_at) < now` condition so `workflow_instances_timeout_due_idx` is range-scanned.
- `findParkedTimeouts` returns only parked instances (`timeout_parked_at IS NOT NULL`, optionally filtered by `workflow_name`), ordered by `timeout_parked_at, uuid`, at most `limit`. It is a plain read and needs no transaction.

**v7.0.0 contract notes:**

- `countInstances` is a **new required method on every `WorkflowInstanceStore`**, whether or not the adapter also implements `WorkflowDefinitionStore`. It counts instances of `workflowName` stamped with `definitionVersion` whose `currentState` is not in `excludeStates`. An empty `excludeStates` MUST exclude nothing (count every matching row); instances with a `null` `definitionVersion` never match. A plain read -- no transaction required. Backs `WorkflowRuntime.initialize()`'s startup executability check and `listDefinitionVersions()`.

**v7.1.0 contract notes:**

- `findInstanceUuids` is a **new optional method** -- unlike `countInstances`, no existing adapter breaks by omitting it. UUIDs of instances of `workflowName` stamped with `definitionVersion`, ascending, strictly after `afterUuid` when given, at most `limit`; instances with a `null` `definitionVersion` never match. A plain read -- no transaction required. Backs `migrateInstances()`'s candidate paging; without it, `migrateInstances()` throws unless the caller passes `instanceUuids` explicitly. See [Instance Migration (v7.1.0)](#instance-migration-v710).

### WorkflowDefinitionStore (v5.0.0)

```ts
interface WorkflowDefinitionStore {
  ensure(record: {
    workflowName: string;
    version: number;
    contentHash: string;
    definitionJson: WorkflowDefinition;
  }): Promise<StoredWorkflowDefinition>;
  findByNameAndVersion(workflowName: string, version: number): Promise<StoredWorkflowDefinition | null>;
  listVersions(workflowName: string): Promise<StoredWorkflowDefinition[]>; // v7.0.0
}

interface StoredWorkflowDefinition {
  workflowName: string;
  version: number;
  contentHash: string;
  definitionJson: WorkflowDefinition;
  registeredAt: Date;
}
```

Optional on `WorkflowPersistenceProvider` -- an adapter that omits it still compiles and runs, it just leaves definition versioning (the version-bump guard, pinning, the startup executability check, `listDefinitionVersions()`) inert.

- `ensure(record)` -- insert-if-absent, **never overwrites** an existing `(workflowName, version)` row; must be atomic under concurrent callers (`INSERT ... ON CONFLICT (workflow_name, version) DO NOTHING` + re-select in both bundled adapters). Not required to be transactional.
- `findByNameAndVersion(workflowName, version)` -- fetch a snapshot; `null` if that pair was never synced. Not required to be transactional.
- `listVersions(workflowName)` _(v7.0.0)_ -- every stored snapshot of `workflowName`, ordered by `version` ascending; `[]` when none exist. Not required to be transactional. Backs the startup executability check and `listDefinitionVersions()`.

### WorkflowHistoryStore

```ts
interface WorkflowHistoryStore {
  append(entry: WorkflowHistoryRecord): Promise<string>; // returns generated UUID
  findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]>;
}
```

### WorkflowTransactionRunner

```ts
interface WorkflowTransactionRunner {
  runInTransaction<T>(callback: () => Promise<T>): Promise<T>;
}
```

### WorkflowClock

```ts
interface WorkflowClock {
  now(): Date;
}
```

### WorkflowPersistenceProvider

```ts
interface WorkflowPersistenceProvider {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
  definitionStore?: WorkflowDefinitionStore; // v5.0.0: optional; omit to leave definition versioning inert
}
```

`pgWorkflowProviders()` and `kyselyWorkflowProviders()` always supply `definitionStore`. A custom provider may omit it -- it still compiles and runs, with definition versioning (version-bump guard, pinning, startup executability check, `listDefinitionVersions()`) inert.

---

## WorkflowRuntime

### Constructor

```ts
new WorkflowRuntime(options: WorkflowRuntimeOptions)
```

| Option               | Type                          | Description                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definitionRegistry` | `WorkflowDefinitionRegistry`  | Registry of workflow definitions                                                                                                                                                                                                                                                                                                                                             |
| `commandRegistry`    | `WorkflowCommandRegistry`     | Registry of command handlers                                                                                                                                                                                                                                                                                                                                                 |
| `instanceStore`      | `WorkflowInstanceStore`       | Instance persistence                                                                                                                                                                                                                                                                                                                                                         |
| `historyStore`       | `WorkflowHistoryStore`        | History persistence                                                                                                                                                                                                                                                                                                                                                          |
| `transactionRunner`  | `WorkflowTransactionRunner`   | Transaction management                                                                                                                                                                                                                                                                                                                                                       |
| `clock`              | `WorkflowClock`               | Clock for timestamps                                                                                                                                                                                                                                                                                                                                                         |
| `maxOnEnterDepth`    | `number`                      | Max onEnter chain depth (default: 10). Throws `InvalidArgumentError` if not a positive safe integer.                                                                                                                                                                                                                                                                         |
| `observers`          | `readonly WorkflowObserver[]` | v1.0.0: lifecycle observers fired post-commit on every state entry                                                                                                                                                                                                                                                                                                           |
| `onObserverError`    | `ObserverErrorHandler`        | v1.0.0: handler invoked when an observer throws (default logs via `console.warn`)                                                                                                                                                                                                                                                                                            |
| `guardRegistry`      | `WorkflowGuardRegistry`       | v1.1.0: registry of guard implementations; required when any definition uses `guard`                                                                                                                                                                                                                                                                                         |
| `timeoutRetry`       | `WorkflowTimeoutRetryOptions` | v6.0.0: `{ initialDelayMs?: 60000, maxDelayMs?: 3600000, maxAttempts?: 10 }`. Backoff before retry n is `min(maxDelayMs, initialDelayMs * 2^(n-1))`; parked at `maxAttempts` consecutive failures. Each must be a positive safe integer and `initialDelayMs <= maxDelayMs`, or the constructor throws `InvalidArgumentError`.                                                |
| `definitionStore`    | `WorkflowDefinitionStore`     | v5.0.0: optional store for definition snapshots. Present -- `initialize()` syncs definitions, enforces the version-bump guard, and (v7.0.0) activates pinning and the startup executability check. Absent -- versioning is inert.                                                                                                                                            |
| `onUnresolvable`     | `"fail" \| "warn"`            | v7.0.0: default `"fail"`. What `initialize()` does when a stored definition version with active instances references an unregistered command/guard or is structurally invalid: `"fail"` throws `WorkflowDefinitionError`; `"warn"` logs via `console.warn` and continues. Only runs with a `definitionStore`. Any other value throws `InvalidArgumentError` at construction. |

### Methods

**`initialize(): Promise<void>`**

Syncs registered definitions into `definitionStore` (enforcing the version-bump guard) and, with a `definitionStore` configured, runs the startup executability check (see [Definition Versioning (v7.0.0)](#definition-versioning-v700)). Idempotent and safe to call concurrently; a failed attempt is not cached. Called automatically by `createInstance()`, `triggerEvent()`, `processExpiredWorkflows()` and `rearmTimeout()`; calling it explicitly at boot is recommended so failures surface before serving traffic (run lazily, a failure fails every one of those calls, for every workflow, until fixed; NestJS calls it during module init). No-ops without a `definitionStore`. **(v7.1.0)** Internally two separately-cached steps -- the sync, then the check; `migrateInstances()` awaits only the sync, since a failing check is often exactly what a migration is fixing.

**`createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance>`**

Creates instance at initial state. Seeds context (state defaults first, input wins). Computes timeout deadline. Processes onEnter chain if present (in transaction).

**`triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult>`**

Within transaction: locks instance (FOR UPDATE), resolves its **governing definition** (v7.0.0 -- the pinned version, loaded from `definitionStore` if it differs from the latest, or the latest under `versionPolicy: "latest"`; throws `IncompatibleDefinitionError` if the instance's state doesn't exist there), validates event, executes commands (fail-fast), transitions state, merges context (state wins), updates instance (version++, stamped with the resolved version), appends history, processes onEnter chain. Returns final landing state.

**`processExpiredWorkflows(input?: ProcessExpiredWorkflowsInput): Promise<ProcessExpiredWorkflowsResult>`**

Scans for due instances (expired, not parked, any scheduled retry reached; FOR UPDATE SKIP LOCKED), then runs one transaction per instance to trigger its timeout event, re-locking, re-checking, and (v7.0.0) resolving its governing definition each first -- independently per instance, so a batch mixing pinned versions works correctly. `limit` is validated (throws `InvalidArgumentError` if not a positive safe integer) and defaults to 100. Per-instance technical failures -- including a resolution failure (missing/invalid snapshot, `IncompatibleDefinitionError`) -- are collected in `failed`, not thrown, and recorded on the instance's `timeoutRetry` (retry with backoff, or parked — listed in `parked`); per-instance business failures (timeout event or its onEnter chain routed to an `errorState`) are reported in `businessFailed`.

**`findParkedTimeouts(input?: FindParkedTimeoutsInput): Promise<WorkflowInstance[]>`** _(v6.0.0)_

Instances parked after `timeoutRetry.maxAttempts` consecutive failed timeout attempts, oldest-parked first. `limit` defaults to 100 (throws `InvalidArgumentError` if not a positive safe integer).

**`rearmTimeout(uuid: string): Promise<WorkflowInstance>`** _(v6.0.0)_

Clears the instance's `timeoutRetry` (un-parking it) so the next `processExpiredWorkflows` retries its timeout if the deadline has passed. Throws `WorkflowInstanceNotFoundError` for an unknown UUID; returns an instance without retry state unchanged.

**`getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]>`**

Returns events available on instance's current state, from its **governing** definition (the pinned version, or the latest under `versionPolicy: "latest"`) -- not necessarily the latest registered one. Throws `IncompatibleDefinitionError` under `"latest"` if the instance's state no longer exists there.

**`listDefinitionVersions(workflowName: string): Promise<DefinitionVersionSummary[]>`** _(v7.0.0)_

Every stored version of `workflowName`, ordered by `version` ascending, each with its non-terminal ("active") instance count. A plain read -- does **not** call `initialize()`. Throws `WorkflowError("listDefinitionVersions requires a definition store")` without a `definitionStore`. See [Definition Versioning (v7.0.0)](#definition-versioning-v700).

**`migrateInstances(input: MigrateInstancesInput): Promise<MigrateInstancesResult>`** _(v7.1.0)_

Moves chosen instances of a workflow from one stored definition version to another: pure relabeling (no commands, guards or `onEnter` run), with an optional `stateMapping` and `transformContext`. Requires a `definitionStore`; awaits only the definition sync half of `initialize()`, not the startup executability check. See [Instance Migration (v7.1.0)](#instance-migration-v710) for the full input/result shape, upfront validation and per-instance semantics.

**`getInstance(uuid: string): Promise<WorkflowInstance | null>`**

Returns instance by UUID or null.

**`getHistory(uuid: string, options?: { limit?; offset? }): Promise<WorkflowHistoryRecord[]>`**

Returns transition history with pagination. `limit` (must be a positive safe integer) and `offset` (must be a non-negative safe integer) are validated when provided; either throws `InvalidArgumentError` if invalid.

**`getHandle(uuid: string): WorkflowHandle`**

Synchronous. Returns thin proxy binding UUID to runtime.

**`addObserver(observer: WorkflowObserver): void`** _(v1.0.0)_

Registers an observer dynamically (in addition to those passed via `WorkflowRuntimeOptions.observers`). Same firing semantics as construction-time observers.

---

## Definition Versioning (v7.0.0)

Requires a `definitionStore` (`pgWorkflowProviders()` / `kyselyWorkflowProviders()` always supply one). Without one, every instance executes the latest registered definition regardless of `versionPolicy`, and a one-time `console.warn` fires the first time an instance is resolved while any registered definition is pinned.

**Which definition governs:**

| Operation                         | Resolution                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `createInstance()`                | Always the latest registered definition.                                                        |
| `triggerEvent()`                  | The instance's pinned version (store lookup, cached per resolver); the latest under `"latest"`. |
| `processExpiredWorkflows()` sweep | Same as `triggerEvent()`, resolved per instance inside its own transaction.                     |
| `getAvailableEvents()`            | Same as `triggerEvent()`.                                                                       |

**Resolution order for an existing instance** (`DefinitionResolver.forInstance`): (1) no `definitionStore` → latest; (2) `instance.definitionVersion === null` (legacy, pre-5.0.0) → latest; (3) the latest registered definition's `versionPolicy === "latest"` → latest if `instance.currentState` is an own key of its `states`, else `IncompatibleDefinitionError`; (4) `instance.definitionVersion === (latest.version ?? 1)` → latest, no store read; (5) otherwise → load the snapshot via `definitionStore.findByNameAndVersion()` (missing → `WorkflowDefinitionError`; structurally invalid → `WorkflowDefinitionError`), validate, deep-freeze, compile, and cache per runtime (`workflowName@version` key, at most one store read per distinct version per process).

### DefinitionVersionSummary

```ts
interface DefinitionVersionSummary {
  version: number;
  contentHash: string;
  registeredAt: Date;
  activeInstances: number; // non-terminal instances stamped with this version
}
```

Returned by `runtime.listDefinitionVersions(workflowName)`, ordered by `version` ascending.

### Startup executability check

Runs at the end of `initialize()`, after the definition sync, only with a `definitionStore` configured. For each registered workflow, for each stored version with active (non-terminal) instances, every referenced command and guard must be registered and the snapshot must pass `WorkflowValidator`'s structure check (e.g. a 6.x snapshot with a `$`-prefixed event name fails it); a workflow whose registered definition has `versionPolicy: "latest"` is skipped entirely (its instances never execute a stored snapshot); without a `guardRegistry`, every guard reference counts as missing. On failure: `onUnresolvable: "fail"` (default) throws `WorkflowDefinitionError` naming the first offending workflow, message listing all; `"warn"` logs via `console.warn` and continues. Without an explicit `initialize()` at boot the check runs lazily, and a failure fails every `createInstance()`/`triggerEvent()`/`processExpiredWorkflows()`/`rearmTimeout()` call, for every workflow, until fixed. Legacy (`null`-version) instances are never counted (they resolve the in-code definition). Workflows removed from code entirely aren't covered.

---

## Instance Migration (v7.1.0)

`runtime.migrateInstances(input)` and `WorkflowService.migrateInstances(input)` move chosen instances of a workflow from one stored definition version to another: pure relabeling -- no commands, guards or `onEnter` run. See [Migrating instances](../docs/workflow-definitions.md#migrating-instances) for when to use it, and [`migrateInstances()`](../docs/core-runtime.md#migrateinstances) for the full walkthrough.

```ts
interface MigrateInstancesInput {
  workflowName: string;
  fromVersion: number;
  toVersion: number;
  stateMapping?: Record<string, string>; // current state -> target state, renamed/removed states only
  transformContext?: (
    context: Record<string, unknown>,
    instance: Readonly<WorkflowInstance>,
  ) => Record<string, unknown>; // pure; result stored as its JSON round trip
  instanceUuids?: readonly string[]; // omit to migrate every instance on fromVersion (needs findInstanceUuids)
  limit?: number; // caps candidates examined, not just migrated; default: no cap
  dryRun?: boolean; // validate and report; write nothing, fire no observers
}

interface MigrateInstancesResult {
  dryRun: boolean;
  migrated: Array<{ uuid: string; fromState: string; toState: string }>; // would-migrate, in a dry run
  skipped: Array<{ uuid: string; reason: string }>;
  failed: Array<{ uuid: string; error: string }>;
}
```

**Upfront validation** -- every row runs before any instance row is touched; the first failure throws and nothing is written:

| Check                                                                            | Error                                                                                                                                  |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A definition store is configured                                                 | `WorkflowError("migrateInstances requires a definition store")`                                                                        |
| `workflowName` is registered                                                     | `WorkflowDefinitionError` (`Workflow not found in registry`)                                                                           |
| `fromVersion`/`toVersion` are positive safe integers, and differ (downgrades OK) | `InvalidArgumentError` (`fromVersion must be a positive integer, got <value>`; `fromVersion and toVersion must differ`)                |
| `limit`, when given, is a positive safe integer                                  | `InvalidArgumentError("limit must be a positive integer, got <value>")`                                                                |
| `toVersion` is in the store and structurally valid                               | `WorkflowDefinitionError("version <toVersion> is not in the definition store")`, loaded the same way a pinned instance's snapshot is   |
| Every `stateMapping` value is an own state of `toVersion`, with no `onEnter`     | `InvalidArgumentError('stateMapping maps "<from>" to "<to>", which is not a state of version <toVersion>')` (or the `onEnter` variant) |
| `instanceUuids` given, or the store implements `findInstanceUuids`               | `WorkflowError("migrateInstances without instanceUuids requires an instance store that implements findInstanceUuids")`                 |

`stateMapping` keys are matched as own properties only (`Object.hasOwn`), never through the prototype chain (a state named `"toString"` is safe).

**Per instance:** lock and re-check (`lockByUuid`) -- an instance moved off `fromVersion` since being listed is skipped, not failed; resolve the target state (`stateMapping`, or the same-named state in `toVersion`, or skip); run `transformContext` if given; relabel `currentState`, `definitionVersion`, `context`, recompute `expiresAt` from `lastTransitionAt` (elapsed time preserved), clear `timeoutRetry`, bump `version`/`updatedAt` -- `lastTransitionAt` itself is unchanged; append a `$migrated` history row (`triggerMetadata: { source: "migration", fromVersion, toVersion }`) and fire observers with `triggerEvent: "$migrated"` after commit. A throw anywhere in this sequence fails only that instance (`failed`); the batch continues.

**Skip reasons** (`result.skipped[].reason`, verbatim): `not found`; `belongs to workflow <name>`; `unstamped` (null `definitionVersion`); `on version <v>, not <fromVersion>`; `state <s> has no mapping and does not exist in version <toVersion>`; `state <s> has an onEnter in version <toVersion>`.

**Candidates:** `instanceUuids`, de-duplicated and in order, when given; otherwise `instanceStore.findInstanceUuids`, paged 100 at a time ascending by UUID, each page after the last UUID seen, until a page is empty or `limit` candidates have been examined. A migrated instance no longer matches `fromVersion`, so re-running the same call is harmless and continues where the last one left off.

**Dry run:** each candidate is read with `findByUuid` (no lock, no transaction); the same resolution and `transformContext` run, but nothing is written and no observers fire.

---

## Observers (v1.0.0)

Observers receive a notification every time the runtime enters a new state. They are intended for cross-cutting concerns — audit logging, metrics, cache invalidation, projections — that must not affect runtime correctness.

### WorkflowObserver

```ts
interface WorkflowObserver {
  readonly name: string;
  onEnter?(event: StateEnterEvent): void | Promise<void>;
}
```

### StateEnterEvent

```ts
interface StateEnterEvent {
  readonly workflowName: string;
  readonly instanceUuid: string;
  readonly state: string; // same as toState
  readonly fromState: string | null; // null on initial-state entry
  readonly toState: string;
  readonly transitionUuid: string; // matches ctx.transitionUuid for the same entry
  readonly triggerEvent: string | null; // null for initial-state entries and onEnter hops
  readonly context: Readonly<Record<string, unknown>>; // deep-cloned + frozen at event time
  readonly metadata: Readonly<Record<string, unknown>>; // deep-cloned + frozen
  readonly triggerMetadata: Readonly<Record<string, unknown>>; // deep-cloned + frozen
  readonly occurredAt: Date;
}
```

### ObserverErrorHandler

```ts
type ObserverErrorHandler = (
  error: unknown,
  observer: { readonly name: string },
  event: StateEnterEvent,
) => void | Promise<void>;
```

### Firing semantics

- **Post-commit** — observer runs only after the state-entering transaction has committed successfully. An observer never sees a state that was rolled back.
- **At-most-once** — an observer that throws is not retried. Observer errors do **not** cause rollback or affect runtime correctness.
- **Sequential** — observers run one after another in registration order.
- **Error-contained** — a thrown error is routed to `onObserverError`
  (default: `console.warn`). The handler itself is also guarded: if it throws,
  the runtime logs via the default handler and continues with the remaining
  observers.
- **Self-transitions count** — command-only events (no `targetState`) fire observers with `fromState === toState`. Filter on `event.fromState === event.toState` to distinguish.
- **Snapshot guarantees** — `context`, `metadata`, and `triggerMetadata` are deep-cloned via `structuredClone` and deep-frozen at event time. Consumers may retain references indefinitely.

### Correlation

`StateEnterEvent.transitionUuid` matches the `transitionUuid` on the `WorkflowExecutionContext` seen by commands that ran during that state entry. This makes it straightforward to correlate command results with observer events in distributed traces.

---

## Guards (v1.1.0)

Per-event preconditions. A guard is a read-only predicate that decides whether an event is allowed to fire. Guards run **before** any commands; if they return `false`, the event short-circuits with `outcome: "guard-rejected"`, no commands run, no state change, and a history row is appended.

### WorkflowGuard

```ts
interface WorkflowGuard<TSubject = unknown> {
  readonly name: string;
  evaluate(subject: TSubject, context: WorkflowExecutionContext): boolean | Promise<boolean>;
}
```

The `name` field on the implementation is informational; the runtime resolves the registry by the **ref name** (`eventDef.guard.name`) and reports that ref name in `rejectedBy`. With aliasing custom registries, the two can diverge — definitions are the source of truth.

### WorkflowGuardRegistry

```ts
interface WorkflowGuardRegistry {
  get(name: string): WorkflowGuard;
  has(name: string): boolean;
}
```

A built-in `InMemoryGuardRegistry` is provided. Custom registries (DI-backed, lazy-loading, etc.) just need to satisfy the interface. The runtime cannot enumerate names from a custom registry, which has implications for bootstrap validation — see [WorkflowValidator](#workflowvalidator).

```ts
import { InMemoryGuardRegistry } from "@duraflows/core";

const guardRegistry = new InMemoryGuardRegistry();
guardRegistry.register("isVerified", { name: "isVerified", evaluate: (s, ctx) => ctx.context.verified === true });
```

### Firing semantics

- **Inside the same transaction** — guard evaluation, the rejection-or-pass decision, and the resulting history append all run inside the per-event transaction.
- **Pure** — the runtime hands the guard a `deepFreeze`d clone of `ctx.context`. Mutations throw under strict mode rather than silently leaking into persisted state. Side effects (DB writes, external calls) belong in commands, which run **after** the guard passes.
- **Re-evaluable** — a timeout sweep retries an instance the next tick if the deadline isn't cleared. Anything non-idempotent inside a guard would repeat without compensation.
- **Not catchable by `errorState`** — `errorState` is for command failures. A guard rejection is meaningful business state ("event not allowed right now"), not a fault.
- **Timeout interaction** — when a guard rejects a timeout-driven event, the runtime additionally clears `expiresAt` so the sweep won't re-pick the instance. The rejection counts toward `ProcessExpiredWorkflowsResult.rejected`, not `processed`.

### Bootstrap validation

When you supply guards via the convenience array path (`InMemoryGuardRegistry` registered through the registered guard names) and pass `knownGuardNames` to the validator, every `eventDef.guard.name` reference is checked at registration. An unresolved ref fails registration with `WorkflowDefinitionError`.

Custom registries can't be enumerated, so when only `guardRegistry` is supplied, validation skips guard refs — they surface only at first use as `WorkflowError` (`Guard "<name>" not found in registry`). The NestJS module follows the same rule: branch on `guardRegistry`, validate when the built-in path is used.

---

## WorkflowHandle

Lightweight proxy. No cached state. Every method call hits persistence.

| Method                              | Returns                             | Description           |
| ----------------------------------- | ----------------------------------- | --------------------- |
| `getInstance()`                     | `Promise<WorkflowInstance \| null>` | Current instance data |
| `triggerEvent(eventName, options?)` | `Promise<WorkflowExecutionResult>`  | Trigger event         |
| `getAvailableEvents()`              | `Promise<AvailableWorkflowEvent[]>` | Available events      |
| `getHistory(options?)`              | `Promise<WorkflowHistoryRecord[]>`  | Transition history    |

**triggerEvent options:** `{ subject?: unknown; triggerMetadata?: Record<string, unknown> }`

---

## Registries

### InMemoryDefinitionRegistry

```ts
new InMemoryDefinitionRegistry(options?: {
  validator?: WorkflowValidator;
  compiler?: WorkflowCompiler;
  validationOptions?: { knownCommandNames?: Set<string> };
})
```

- `register(definition: WorkflowDefinition)` -- validates + compiles eagerly
- `get(workflowName: string): WorkflowDefinition` -- throws `WorkflowDefinitionError` if not found
- `has(workflowName: string): boolean`
- `getAll(): WorkflowDefinition[]`

### InMemoryCommandRegistry

```ts
new InMemoryCommandRegistry();
```

- `register(name: string, command: WorkflowCommand)` -- throws on duplicate
- `get(name: string): WorkflowCommand` -- throws if not found
- `has(name: string): boolean`

---

## WorkflowValidator

```ts
const validator = new WorkflowValidator();
const result = validator.validate(definition, options?);
```

**Options:** `{ knownCommandNames?: Set<string>; knownGuardNames?: Set<string> }`

**Returns:** `{ valid: boolean; errors: Array<{ path: string; message: string }> }`

**Validation rules:**

1. `name` must be non-empty
2. `states` must contain at least one entry
3. `initialState` must exist in `states`
4. Every `targetState` and `errorState` must reference valid state names
5. Events must define at least one of `targetState`, `errorState`, or `commands` (v1.0.0 — `targetState` alone no longer required, enabling command-only and failure-only events)
6. At most one event per state may define a `timeout`
7. Timeout duration fields must be positive numbers
8. At least one timeout duration field must be defined
9. All command names must exist in `knownCommandNames` (if provided)
10. No cycles in the `onEnter` graph (DFS-based detection)
11. Definitions are **deep-cloned and deep-frozen** at registration (v1.0.0) — caller mutations to the source object after `register()` cannot corrupt the registered definition
12. **(v1.1.0)** All `guard.name` refs must exist in `knownGuardNames` (if provided). When using a custom `WorkflowGuardRegistry` (which can't be enumerated), pass `undefined` for `knownGuardNames` and let unresolved refs surface at first use as `WorkflowError`.
13. **(v7.0.0)** Event names starting with `"$"` are rejected: `'Event names starting with "$" are reserved'`, reported at path `states.<state>.events.<name>`. Reserved for future system-generated events (e.g. `$migrated`).

---

## WorkflowCompiler

```ts
const compiler = new WorkflowCompiler();
const compiled = compiler.compile(definition);
// compiled.process: finita ProcessInterface
// compiled.definition: WorkflowDefinition
```

Caches by definition name. Invalidates on definition change (JSON hash comparison).

---

## NestJS Integration

### WorkflowModule.forRoot()

```ts
WorkflowModule.forRoot(options: WorkflowModuleOptions)
```

| Option              | Type                            | Description                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflows`         | `WorkflowDefinition[]`          | Definitions to register                                                                                                                                                                                                                       |
| `commands`          | `WorkflowCommandRegistration[]` | Explicit command registrations `{ name, useClass }`                                                                                                                                                                                           |
| `guards`            | `WorkflowGuard[]`               | v1.1.0: built-in guard implementations. Module wires them into an `InMemoryGuardRegistry` automatically.                                                                                                                                      |
| `guardRegistry`     | `WorkflowGuardRegistry`         | v1.1.0: prebuilt custom registry. Mutually exclusive with `guards`; throws synchronously if both given.                                                                                                                                       |
| `observers`         | `WorkflowObserver[]`            | v1.0.0: lifecycle observers                                                                                                                                                                                                                   |
| `onObserverError`   | `ObserverErrorHandler`          | v1.0.0: handler for observer throws (default `console.warn`)                                                                                                                                                                                  |
| `persistence`       | `WorkflowPersistenceProvider`   | Persistence providers                                                                                                                                                                                                                         |
| `clock`             | `WorkflowClock`                 | Optional clock override                                                                                                                                                                                                                       |
| `timeoutRetry`      | `WorkflowTimeoutRetryOptions`   | v6.1.0: how timeout failures are retried and parked (`{ initialDelayMs?, maxDelayMs?, maxAttempts? }`); see [core-runtime.md](../docs/core-runtime.md#retries-and-parking)                                                                    |
| `onUnresolvable`    | `"fail" \| "warn"`              | v7.0.0: default `"fail"`. What module init does when a stored definition version with active instances references an unregistered command/guard or is structurally invalid; see [Definition Versioning (v7.0.0)](#definition-versioning-v700) |
| `enableControllers` | `boolean`                       | Enable REST endpoints                                                                                                                                                                                                                         |

### WorkflowModule.forRootAsync()

```ts
WorkflowModule.forRootAsync<TArgs extends unknown[] = unknown[]>(
  options: WorkflowModuleAsyncOptions<TArgs>,
)
```

**v1.0.0:** generic over factory args. Declaring `forRootAsync<[ServiceA, ServiceB]>({ ... })` typechecks `inject` against `useFactory` parameters. Without the type parameter, args default to `unknown[]`.

| Option              | Type                                                                                      | Description                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `imports`           | `Type<unknown>[]`                                                                         | Modules to import (must export anything injected into the factory, including observer providers) |
| `commands`          | `WorkflowCommandRegistration[]`                                                           | Explicit commands (static, not from factory)                                                     |
| `enableControllers` | `boolean`                                                                                 | Enable REST endpoints (static, not from factory)                                                 |
| `useFactory`        | `(...args: TArgs) => WorkflowModuleFactoryConfig \| Promise<WorkflowModuleFactoryConfig>` | Async-resolved config                                                                            |
| `inject`            | `InjectionToken[]`                                                                        | DI tokens to inject (must align with `TArgs`)                                                    |

**WorkflowModuleFactoryConfig:**

| Property          | Type                          | Description                                                                                                                                                                |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflows`       | `WorkflowDefinition[]`        | Definitions to register                                                                                                                                                    |
| `persistence`     | `WorkflowPersistenceProvider` | Persistence providers                                                                                                                                                      |
| `clock`           | `WorkflowClock`               | Optional clock override                                                                                                                                                    |
| `observers`       | `WorkflowObserver[]`          | v1.0.0: observers — moved here from top-level (BREAKING in v1.0.0) so they can compose from injected services                                                              |
| `onObserverError` | `ObserverErrorHandler`        | v1.0.0: handler for observer throws                                                                                                                                        |
| `guards`          | `WorkflowGuard[]`             | v1.1.0: built-in guards composed into an `InMemoryGuardRegistry`. Mutually exclusive with `guardRegistry`.                                                                 |
| `guardRegistry`   | `WorkflowGuardRegistry`       | v1.1.0: prebuilt custom registry. Mutually exclusive with `guards`.                                                                                                        |
| `timeoutRetry`    | `WorkflowTimeoutRetryOptions` | v6.1.0: how timeout failures are retried and parked (`{ initialDelayMs?, maxDelayMs?, maxAttempts? }`); see [core-runtime.md](../docs/core-runtime.md#retries-and-parking) |
| `onUnresolvable`  | `"fail" \| "warn"`            | v7.0.0: default `"fail"`. Same as `WorkflowModuleOptions.onUnresolvable` above.                                                                                            |

**v1.0.0 BREAKING — observers moved into `useFactory`:**

```ts
// BEFORE (v0.x) — no longer works
WorkflowModule.forRootAsync({
  observers: [myObserver],     // removed from top level
  useFactory: () => ({ ... }),
});

// AFTER (v1.0.0+) — observers in factory return value
WorkflowModule.forRootAsync<[AuditService]>({
  imports: [AuditModule],
  useFactory: (audit) => ({
    workflows: [orderWorkflow],
    persistence: pgWorkflowProviders(pool),
    observers: [{ name: "audit", onEnter: (e) => audit.record(e) }],
  }),
  inject: [AuditService],
});
```

`forRoot` (synchronous) is unaffected — `observers` remains a top-level option there.

**Observer DI scope gotcha:** `WorkflowModule.forRootAsync` is itself a `DynamicModule`. Its factory can only inject providers that are global, declared in this module's `imports`, or exported by modules in `imports`. Bundling observers in their own module (`@Module({ providers: [MyObserver], exports: [MyObserver] })`) and adding it to `forRootAsync`'s `imports` is the standard pattern.

### @WorkflowCommand Decorator

```ts
import { WorkflowCommand } from "@duraflows/nestjs";

@WorkflowCommand("commandName")
export class MyCommand implements WorkflowCommandInterface {
  constructor(/* NestJS DI */) {}
  async execute(subject, ctx): Promise<CommandResult> {
    /* ... */
  }
}
```

Auto-discovered via NestJS `DiscoveryService`. No explicit `commands` array needed.

### WorkflowService

Inject via `@Inject(WORKFLOW_RUNTIME)` or use the service directly:

```ts
@Injectable()
export class MyService {
  constructor(private readonly workflowService: WorkflowService) {}
}
```

**Methods:**

- `createInstance(input): Promise<WorkflowInstance>`
- `triggerEvent(input): Promise<WorkflowExecutionResult>`
- `getAvailableEvents(input): Promise<AvailableWorkflowEvent[]>`
- `getInstance(uuid): Promise<WorkflowInstance | null>`
- `getHistory(uuid, options?): Promise<WorkflowHistoryRecord[]>` _(returns newest-first; check the runtime's history store ordering)_
- `listDefinitionVersions(workflowName): Promise<DefinitionVersionSummary[]>` _(v7.0.0)_ — delegates to the runtime
- `migrateInstances(input: MigrateInstancesInput): Promise<MigrateInstancesResult>` _(v7.1.0)_ — delegates to the runtime; no HTTP endpoint exposes it
- `getHandle(uuid): WorkflowHandle`

**v1.0.0 (mostly invisible):** `WorkflowService` constructor now takes a single `WorkflowRuntime` argument and delegates queries to runtime methods. Affects only consumers that manually instantiate `WorkflowService` outside the NestJS DI container; standard usage is unchanged.

### WorkflowTimeoutService

```ts
@Injectable()
export class MyScheduler {
  constructor(private readonly timeoutService: WorkflowTimeoutService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTimeouts() {
    await this.timeoutService.processExpiredWorkflows(100);
  }
}
```

**Methods:**

- `processExpiredWorkflows(limit?): Promise<ProcessExpiredWorkflowsResult>`
- `findParkedTimeouts(input?: FindParkedTimeoutsInput): Promise<WorkflowInstance[]>` _(v6.0.0)_ — delegates to the runtime
- `rearmTimeout(uuid): Promise<WorkflowInstance>` _(v6.0.0)_ — delegates to the runtime

`WorkflowModule` passes `timeoutRetry` to the runtime: from `WorkflowModuleOptions` (`forRoot`) or from the `useFactory` config (`forRootAsync`). Omit it to use the defaults.

### Injection Tokens

| Token                          | Type                             |
| ------------------------------ | -------------------------------- |
| `WORKFLOW_RUNTIME`             | `WorkflowRuntime`                |
| `WORKFLOW_INSTANCE_STORE`      | `WorkflowInstanceStore`          |
| `WORKFLOW_HISTORY_STORE`       | `WorkflowHistoryStore`           |
| `WORKFLOW_COMMAND_REGISTRY`    | `WorkflowCommandRegistry`        |
| `WORKFLOW_DEFINITION_REGISTRY` | `WorkflowDefinitionRegistry`     |
| `WORKFLOW_GUARD_REGISTRY`      | `WorkflowGuardRegistry` (v1.1.0) |
| `WORKFLOW_TRANSACTION_RUNNER`  | `WorkflowTransactionRunner`      |
| `WORKFLOW_CLOCK`               | `WorkflowClock`                  |

### REST Controllers (enableControllers: true)

| Method | Path                                 | Description                            |
| ------ | ------------------------------------ | -------------------------------------- |
| `POST` | `/workflows`                         | Create instance                        |
| `GET`  | `/workflows/:uuid`                   | Get instance                           |
| `POST` | `/workflows/:uuid/events/:eventName` | Trigger event                          |
| `GET`  | `/workflows/:uuid/events`            | List available events                  |
| `GET`  | `/workflows/:uuid/history`           | Get history (query: `limit`, `offset`) |
| `POST` | `/workflows/timeouts/process`        | Process expired (query: `limit`)       |

---

## PostgreSQL Adapter

### pgWorkflowProviders

```ts
import { pgWorkflowProviders } from "@duraflows/pg";

const providers = pgWorkflowProviders(pool);
// providers.instanceStore: PgWorkflowInstanceStore
// providers.historyStore: PgWorkflowHistoryStore
// providers.transactionRunner: PgTransactionRunner

// Optional transaction-scoped timeouts (both default to unset):
const bounded = pgWorkflowProviders(pool, { lockTimeoutMs: 3000, statementTimeoutMs: 30_000 });
```

Uses `AsyncLocalStorage` for transaction context propagation. Supports nested transactions (inner reuses outer's client).

`lockTimeoutMs` and `statementTimeoutMs` are applied with `SET LOCAL` inside each transaction. `lockTimeoutMs` bounds how long a statement waits for a row lock and is the recommended setting; `statementTimeoutMs` bounds total per-statement time and can abort legitimately slow command SQL, which is why neither is enabled by default. See [Transaction Timeouts](../docs/persistence.md#transaction-timeouts).

**v1.0.0:** instance `metadata` is **write-once** — `metadata_json` was removed from the `UPDATE` statement. The runtime never overwrites metadata after `create()`. Custom adapters must enforce this same contract.

## Kysely Adapter (v0.4.0)

### kyselyWorkflowProviders

```ts
import { kyselyWorkflowProviders } from "@duraflows/kysely";

const providers = kyselyWorkflowProviders(db);
// providers.instanceStore: KyselyWorkflowInstanceStore
// providers.historyStore: KyselyWorkflowHistoryStore
// providers.transactionRunner: KyselyTransactionRunner

// Optional transaction-scoped timeouts (both default to unset):
const bounded = kyselyWorkflowProviders(db, { lockTimeoutMs: 3000 });
```

Same shape and same timeout options as `pgWorkflowProviders` (applied via `set_config(..., true)` rather than a raw `SET LOCAL`). Uses `AsyncLocalStorage` for transaction context propagation, same nested-transaction support as the pg adapter.

Pick `@duraflows/kysely` when the project already uses Kysely; pick `@duraflows/pg` when the project uses raw `pg`. Both implement the same interfaces and the conformance suite proves it.

### generateMigrationSql

```ts
import { generateMigrationSql } from "@duraflows/pg";

const { up, down } = generateMigrationSql(); // PG 13+ (gen_random_uuid)
const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" }); // PG 18+ (time-ordered)
```

### Database Schema

**workflow_instances:**

| Column               | Type          | Notes                                                                              |
| -------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `uuid`               | `uuid`        | PK, supplied by application                                                        |
| `workflow_name`      | `text`        | NOT NULL                                                                           |
| `current_state`      | `text`        | NOT NULL                                                                           |
| `version`            | `integer`     | NOT NULL, DEFAULT 0                                                                |
| `definition_version` | `integer`     | NULL on legacy rows (v5.0.0)                                                       |
| `expires_at`         | `timestamptz` | NULL if no timeout                                                                 |
| `last_transition_at` | `timestamptz` | NOT NULL                                                                           |
| `context_json`       | `jsonb`       | NOT NULL, DEFAULT '{}'                                                             |
| `metadata_json`      | `jsonb`       | NOT NULL, DEFAULT '{}'                                                             |
| `created_at`         | `timestamptz` | NOT NULL                                                                           |
| `updated_at`         | `timestamptz` | NOT NULL                                                                           |
| `timeout_attempts`   | `integer`     | NOT NULL, DEFAULT 0 (v6.0.0) — `timeoutRetry.attempts`; `0` ⇔ `timeoutRetry: null` |
| `timeout_retry_at`   | `timestamptz` | NULL (v6.0.0) — `timeoutRetry.retryAt`                                             |
| `timeout_last_error` | `text`        | NULL (v6.0.0) — `timeoutRetry.lastError`; NULL with attempts > 0 reads as `""`     |
| `timeout_parked_at`  | `timestamptz` | NULL (v6.0.0) — `timeoutRetry.parkedAt`                                            |

Writing `timeoutRetry: null` stores `timeout_attempts = 0` and NULL in the other three `timeout_*` columns. The columns come from migration `005_timeout_retries.sql`, which must be applied before deploying 6.0.0.

**workflow_history:**

| Column                   | Type          | Notes                                                                                                             |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `uuid`                   | `uuid`        | PK, auto-generated                                                                                                |
| `workflow_instance_uuid` | `uuid`        | FK -> workflow_instances                                                                                          |
| `from_state`             | `text`        | NULL for creation                                                                                                 |
| `event_name`             | `text`        | NOT NULL ("onEnter" for auto-transitions)                                                                         |
| `to_state`               | `text`        | NOT NULL                                                                                                          |
| `outcome`                | `text`        | CHECK ('success', 'failure', 'guard-rejected') (v1.1.0 extends CHECK)                                             |
| `error_message`          | `text`        |                                                                                                                   |
| `rejected_by`            | `text`        | v1.1.0: declared `eventDef.guard.name` for guard-rejected rows; NULL otherwise (migration `003_event_guards.sql`) |
| `command_results_json`   | `jsonb`       | NOT NULL, DEFAULT '[]'                                                                                            |
| `trigger_metadata_json`  | `jsonb`       | NOT NULL, DEFAULT '{}'                                                                                            |
| `definition_version`     | `integer`     | v5.0.0: definition version that governed the transition; NULL on legacy rows                                      |
| `created_at`             | `timestamptz` | NOT NULL                                                                                                          |

**Indexes:**

- `workflow_instances_workflow_name_idx` on `(workflow_name)`
- `workflow_instances_expires_at_idx` on `(expires_at)` WHERE `expires_at IS NOT NULL`
- `workflow_instances_timeout_due_idx` on `(coalesce(timeout_retry_at, expires_at))` WHERE `expires_at IS NOT NULL AND timeout_parked_at IS NULL` (v6.0.0) — `findExpired`'s due scan
- `workflow_instances_timeout_parked_idx` on `(timeout_parked_at)` WHERE `timeout_parked_at IS NOT NULL` (v6.0.0) — `findParkedTimeouts`
- `workflow_instances_definition_version_idx` on `(workflow_name, definition_version)` (v7.0.0, recommended not required, migration `006_definition_version_index.sql`) — keeps `countInstances()` (the startup executability check, `listDefinitionVersions()`) cheap on large tables
- `workflow_history_instance_created_idx` on `(workflow_instance_uuid, created_at DESC)`

---

## Mermaid Diagrams (v0.3.0)

### toMermaidDiagram

```ts
import { toMermaidDiagram } from "@duraflows/core";

const diagram = toMermaidDiagram(definition); // default: TB direction, no command labels
const detailed = toMermaidDiagram(definition, { showCommands: true }); // include command names
const horizontal = toMermaidDiagram(definition, { direction: "LR" }); // left-to-right
```

**MermaidDiagramOptions:**

| Option         | Type           | Default | Description                       |
| -------------- | -------------- | ------- | --------------------------------- |
| `showCommands` | `boolean`      | `false` | Show command names on event nodes |
| `direction`    | `"TB" \| "LR"` | `"TB"`  | Diagram direction                 |

Returns a string of valid Mermaid `flowchart` syntax. Visual encoding: success paths green, error paths red dashed, timeouts use ⧖, onEnter hops use 🗲, terminal states connect to an end node.

---

## Adapter Conformance (`@duraflows/core/testing`, v1.0.0)

```ts
import { runInstanceStoreConformance } from "@duraflows/core/testing";

describe("MyInstanceStore conformance", () => {
  runInstanceStoreConformance({
    setup: async () => {
      // Return { store, transactionRunner, teardown }
    },
  });
});
```

`runInstanceStoreConformance` is the canonical way to verify a custom `WorkflowInstanceStore` against the persistence contract. It exercises:

- `lockByUuid()` row-level locking and transaction-required behavior
- `update()` optimistic locking on `version`
- `findExpired()` ordering, limit, and `SKIP LOCKED` semantics
- `timeoutRetry` round-trips through `create` / `update`; `findExpired()` skips parked and not-yet-due retries and orders by due time; `findParkedTimeouts()` filtering, ordering and limit (v6.0.0)
- `metadata` write-once enforcement (v1.0.0 contract)
- `countInstances()` filtering by workflow, definition version and excluded states, and that an empty `excludeStates` counts everything (v7.0.0)
- `findInstanceUuids()` paging by workflow and definition version, `afterUuid` and `limit`, ascending by `uuid`; the case is skipped (`ctx.skip()`) when the adapter doesn't implement it (v7.1.0, optional)
- Nested-transaction reuse via `transactionRunner`

Adapters that pass this suite are guaranteed to work with the runtime. `@duraflows/pg` and `@duraflows/kysely` both run it as part of their CI.

A sibling suite, `runDefinitionStoreConformance(label, harness)` (same subpath), verifies a `WorkflowDefinitionStore`: `ensure()` insert-if-absent semantics (never overwrites), `findByNameAndVersion()` round-trip and unknown-pair handling, independent storage of different versions, and (v7.0.0) `listVersions()` ordering and per-workflow filtering.

---

## Error Types

### WorkflowError (base)

```ts
class WorkflowError extends Error {
  constructor(message: string, cause?: unknown);
}
```

Thrown for: instance not found, optimistic lock failure, command not in registry, `listDefinitionVersions`/`migrateInstances` without a `definitionStore`, and (v7.1.0) `migrateInstances` called without `instanceUuids` when the instance store has no `findInstanceUuids`.

### WorkflowDefinitionError

```ts
class WorkflowDefinitionError extends WorkflowError {
  readonly workflowName: string;
}
```

Thrown for: duplicate registration, validation failure, unknown workflow lookup, content changed without a version bump, (v7.0.0) the startup executability check finding an unregistered command/guard or a structurally invalid snapshot (`onUnresolvable: "fail"`) or a pinned instance resolving to a missing/invalid stored snapshot, and (v7.1.0) `migrateInstances`'s `toVersion` not being in the definition store.

### InvalidArgumentError

```ts
class InvalidArgumentError extends WorkflowError {
  constructor(message: string);
}
```

Thrown when: a caller passes an invalid numeric argument — `processExpiredWorkflows`'s `limit`, `findParkedTimeouts`'s `limit`, `getHistory`'s `limit`/`offset`, `migrateInstances`'s `fromVersion`/`toVersion`/`limit` (v7.1.0), or the `WorkflowRuntime` constructor's `maxOnEnterDepth` or `timeoutRetry` options — that isn't a positive (or, for `offset`, non-negative) safe integer. Also thrown when: the `WorkflowRuntime` constructor's `onUnresolvable` (v7.0.0) is provided and isn't `"fail"` or `"warn"`; (v7.1.0) `migrateInstances`'s `fromVersion` equals `toVersion`, or its `stateMapping` names a state that isn't an own state of `toVersion`, or one that has an `onEnter` there.

### InvalidEventError

```ts
class InvalidEventError extends WorkflowError {
  readonly workflowInstanceUuid: string;
  readonly currentState: string;
  readonly eventName: string;
}
```

Thrown when: event not available on current state.

### IncompatibleDefinitionError (v7.0.0)

```ts
class IncompatibleDefinitionError extends WorkflowError {
  readonly workflowInstanceUuid: string;
  readonly workflowName: string;
  readonly currentState: string;
  readonly version: number;
}
```

Thrown when: under `versionPolicy: "latest"`, an instance's `currentState` is not an own key of the latest registered definition's `states`. An event no longer defined on a state the definition still has throws `InvalidEventError` instead. In `@duraflows/nestjs`, `WorkflowExceptionFilter` maps this to **409 Conflict**, same as `InvalidEventError`.

### CommandFailureError

```ts
class CommandFailureError extends WorkflowError {
  readonly workflowInstanceUuid: string;
  readonly eventName: string;
  readonly commandName: string;
  readonly result: CommandResult;
}
```

Thrown when: a **mandatory** command returns `{ ok: false }` and no `errorState` is defined. `bestEffort: true` commands never trigger this — they record the failed result and continue.

### OnEnterDepthExceededError

```ts
class OnEnterDepthExceededError extends WorkflowError {
  readonly workflowInstanceUuid: string;
  readonly stateName: string;
  readonly depth: number;
}
```

Thrown when: onEnter chain exceeds `maxOnEnterDepth`.
