# duraflows API Reference

> Corresponds to duraflows **v1.0.0**. For the latest, check the source at [github.com/camcima/duraflows](https://github.com/camcima/duraflows).

---

## Package Exports

### @duraflows/core

**Types:**
`WorkflowDefinition`, `WorkflowStateDefinition`, `WorkflowEventDefinition`, `WorkflowOnEnterDefinition`, `WorkflowCommandRef`, `WorkflowTimeoutDefinition`, `WorkflowCommand`, `CommandResult`, `WorkflowExecutionContext`, `WorkflowInstance`, `WorkflowExecutionResult`, `OnEnterChainResult`, `OnEnterHopResult`, `AvailableWorkflowEvent`, `WorkflowHistoryRecord`, `CreateWorkflowInstanceInput`, `TriggerWorkflowEventInput`, `ProcessExpiredWorkflowsInput`, `ProcessExpiredWorkflowsResult`, `GetAvailableEventsInput`, `WorkflowInstanceStore`, `WorkflowHistoryStore`, `WorkflowTransactionRunner`, `WorkflowClock`, `WorkflowPersistenceProvider`, `WorkflowDefinitionRegistry`, `WorkflowCommandRegistry`, `WorkflowObserver`, `StateEnterEvent`, `ObserverErrorHandler`, `WorkflowRuntimeOptions`

**Classes:**
`WorkflowRuntime`, `WorkflowHandle`, `WorkflowValidator`, `WorkflowCompiler`, `CommandExecutor`, `EventExecutor`, `OnEnterExecutor`, `TimeoutResolver`, `InMemoryDefinitionRegistry`, `InMemoryCommandRegistry`, `ObserverRegistry`

**Functions:**
`toMermaidDiagram(definition, options?)` — renders a Mermaid flowchart for a `WorkflowDefinition` (added v0.3.0).

**Subpath export — `@duraflows/core/testing`:**
`runInstanceStoreConformance(factory)` — shared conformance suite. Adapter authors run this against their `WorkflowInstanceStore` to verify the persistence contract (locking, optimistic concurrency, expiration).

**Errors:**
`WorkflowError`, `WorkflowDefinitionError`, `InvalidEventError`, `CommandFailureError`, `OnEnterDepthExceededError`

### @duraflows/pg

`pgWorkflowProviders(pool)`, `generateMigrationSql(options?)`, `PgWorkflowInstanceStore`, `PgWorkflowHistoryStore`, `PgTransactionRunner`, `PgTransactionContext`

### @duraflows/kysely

`kyselyWorkflowProviders(db)`, `KyselyWorkflowInstanceStore`, `KyselyWorkflowHistoryStore`, `KyselyTransactionRunner`, `KyselyTransactionContext`, plus `WorkflowDatabase` table type definitions. Added in v0.4.0 — alternative to `@duraflows/pg` for projects already using Kysely.

### @duraflows/nestjs

`WorkflowModule`, `WorkflowService`, `WorkflowTimeoutService`, `WorkflowCommand` (decorator), `WORKFLOW_RUNTIME`, `WORKFLOW_INSTANCE_STORE`, `WORKFLOW_HISTORY_STORE`, `WORKFLOW_COMMAND_REGISTRY`, `WORKFLOW_DEFINITION_REGISTRY`, `WORKFLOW_TRANSACTION_RUNNER`, `WORKFLOW_CLOCK`. Also re-exports the entire `@duraflows/core` public API (including observer types) so apps can import everything from a single package.

---

## Definition Types

### WorkflowDefinition

```ts
interface WorkflowDefinition {
  name: string; // unique identifier
  initialState: string; // must exist in states
  states: Record<string, WorkflowStateDefinition>; // at least one state required
}
```

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
  expiresAt: Date | null; // timeout deadline
  lastTransitionAt: Date;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

### WorkflowExecutionResult

```ts
interface WorkflowExecutionResult {
  outcome: "success" | "failure";
  fromState: string;
  toState: string; // final state after any onEnter chain
  commandResults: CommandResult[];
  historyUuid: string;
}
```

`outcome` (v1.0.0) is aggregated across both the event execution and the subsequent onEnter chain:

```
outcome = eventResult.outcome === "failure" || onEnterChain.outcome === "failure"
  ? "failure"
  : "success"
```

A best-effort command returning `ok: false` does **not** taint `outcome`. A mandatory command routing to `errorState` surfaces as `outcome: "failure"` even if subsequent onEnter hops succeed.

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
  uuid: string;
  workflowInstanceUuid: string;
  fromState: string | null; // null for creation
  eventName: string; // "onEnter" for auto-transitions
  toState: string;
  outcome: "success" | "failure";
  errorMessage?: string;
  commandResults: CommandResult[];
  triggerMetadata: Record<string, unknown>;
  createdAt: Date;
}
```

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
  processed: number;
  failed: Array<{ uuid: string; error: string }>;
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
  findExpired(limit: number, now: Date): Promise<WorkflowInstance[]>; // FOR UPDATE SKIP LOCKED (REQUIRES active transaction)
}
```

**v1.0.0 contract notes** (also enforced by `runInstanceStoreConformance`):

- `lockByUuid` / `findExpired` MUST throw if called outside a transaction.
- `update` MUST NOT modify `metadata_json` — metadata is write-once after `create()`.
- `findExpired` MUST honor `SKIP LOCKED` semantics (or the platform equivalent) so concurrent workers don't block each other.

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
}
```

---

## WorkflowRuntime

### Constructor

```ts
new WorkflowRuntime(options: WorkflowRuntimeOptions)
```

| Option               | Type                          | Description                                                                       |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `definitionRegistry` | `WorkflowDefinitionRegistry`  | Registry of workflow definitions                                                  |
| `commandRegistry`    | `WorkflowCommandRegistry`     | Registry of command handlers                                                      |
| `instanceStore`      | `WorkflowInstanceStore`       | Instance persistence                                                              |
| `historyStore`       | `WorkflowHistoryStore`        | History persistence                                                               |
| `transactionRunner`  | `WorkflowTransactionRunner`   | Transaction management                                                            |
| `clock`              | `WorkflowClock`               | Clock for timestamps                                                              |
| `maxOnEnterDepth`    | `number`                      | Max onEnter chain depth (default: 10)                                             |
| `observers`          | `readonly WorkflowObserver[]` | v1.0.0: lifecycle observers fired post-commit on every state entry                |
| `onObserverError`    | `ObserverErrorHandler`        | v1.0.0: handler invoked when an observer throws (default logs via `console.warn`) |

### Methods

**`createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance>`**

Creates instance at initial state. Seeds context (state defaults first, input wins). Computes timeout deadline. Processes onEnter chain if present (in transaction).

**`triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult>`**

Within transaction: locks instance (FOR UPDATE), validates event, executes commands (fail-fast), transitions state, merges context (state wins), updates instance (version++), appends history, processes onEnter chain. Returns final landing state.

**`processExpiredWorkflows(input?: ProcessExpiredWorkflowsInput): Promise<ProcessExpiredWorkflowsResult>`**

Finds expired instances (FOR UPDATE SKIP LOCKED), triggers their timeout events. Individual failures collected, not thrown. Default limit: 100.

**`getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]>`**

Returns events available on instance's current state.

**`getInstance(uuid: string): Promise<WorkflowInstance | null>`**

Returns instance by UUID or null.

**`getHistory(uuid: string, options?: { limit?; offset? }): Promise<WorkflowHistoryRecord[]>`**

Returns transition history with pagination.

**`getHandle(uuid: string): WorkflowHandle`**

Synchronous. Returns thin proxy binding UUID to runtime.

**`addObserver(observer: WorkflowObserver): void`** _(v1.0.0)_

Registers an observer dynamically (in addition to those passed via `WorkflowRuntimeOptions.observers`). Same firing semantics as construction-time observers.

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
type ObserverErrorHandler = (error: unknown, observer: { readonly name: string }, event: StateEnterEvent) => void;
```

### Firing semantics

- **Post-commit** — observer runs only after the state-entering transaction has committed successfully. An observer never sees a state that was rolled back.
- **At-most-once** — an observer that throws is not retried. Observer errors do **not** cause rollback or affect runtime correctness.
- **Sequential** — observers run one after another in registration order.
- **Error-contained** — a thrown error is routed to `onObserverError` (default: `console.warn`).
- **Self-transitions count** — command-only events (no `targetState`) fire observers with `fromState === toState`. Filter on `event.fromState === event.toState` to distinguish.
- **Snapshot guarantees** — `context`, `metadata`, and `triggerMetadata` are deep-cloned via `structuredClone` and deep-frozen at event time. Consumers may retain references indefinitely.

### Correlation

`StateEnterEvent.transitionUuid` matches the `transitionUuid` on the `WorkflowExecutionContext` seen by commands that ran during that state entry. This makes it straightforward to correlate command results with observer events in distributed traces.

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

**Options:** `{ knownCommandNames?: Set<string> }`

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

| Option              | Type                            | Description                                                  |
| ------------------- | ------------------------------- | ------------------------------------------------------------ |
| `workflows`         | `WorkflowDefinition[]`          | Definitions to register                                      |
| `commands`          | `WorkflowCommandRegistration[]` | Explicit command registrations `{ name, useClass }`          |
| `observers`         | `WorkflowObserver[]`            | v1.0.0: lifecycle observers                                  |
| `onObserverError`   | `ObserverErrorHandler`          | v1.0.0: handler for observer throws (default `console.warn`) |
| `persistence`       | `WorkflowPersistenceProvider`   | Persistence providers                                        |
| `clock`             | `WorkflowClock`                 | Optional clock override                                      |
| `enableControllers` | `boolean`                       | Enable REST endpoints                                        |

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

| Property          | Type                          | Description                                                                                                   |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `workflows`       | `WorkflowDefinition[]`        | Definitions to register                                                                                       |
| `persistence`     | `WorkflowPersistenceProvider` | Persistence providers                                                                                         |
| `clock`           | `WorkflowClock`               | Optional clock override                                                                                       |
| `observers`       | `WorkflowObserver[]`          | v1.0.0: observers — moved here from top-level (BREAKING in v1.0.0) so they can compose from injected services |
| `onObserverError` | `ObserverErrorHandler`        | v1.0.0: handler for observer throws                                                                           |

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

### Injection Tokens

| Token                          | Type                         |
| ------------------------------ | ---------------------------- |
| `WORKFLOW_RUNTIME`             | `WorkflowRuntime`            |
| `WORKFLOW_INSTANCE_STORE`      | `WorkflowInstanceStore`      |
| `WORKFLOW_HISTORY_STORE`       | `WorkflowHistoryStore`       |
| `WORKFLOW_COMMAND_REGISTRY`    | `WorkflowCommandRegistry`    |
| `WORKFLOW_DEFINITION_REGISTRY` | `WorkflowDefinitionRegistry` |
| `WORKFLOW_TRANSACTION_RUNNER`  | `WorkflowTransactionRunner`  |
| `WORKFLOW_CLOCK`               | `WorkflowClock`              |

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
```

Uses `AsyncLocalStorage` for transaction context propagation. Supports nested transactions (inner reuses outer's client).

**v1.0.0:** instance `metadata` is **write-once** — `metadata_json` was removed from the `UPDATE` statement. The runtime never overwrites metadata after `create()`. Custom adapters must enforce this same contract.

## Kysely Adapter (v0.4.0)

### kyselyWorkflowProviders

```ts
import { kyselyWorkflowProviders } from "@duraflows/kysely";

const providers = kyselyWorkflowProviders(db);
// providers.instanceStore: KyselyWorkflowInstanceStore
// providers.historyStore: KyselyWorkflowHistoryStore
// providers.transactionRunner: KyselyTransactionRunner
```

Same shape as `pgWorkflowProviders`. Uses `AsyncLocalStorage` for transaction context propagation, same nested-transaction support as the pg adapter.

Pick `@duraflows/kysely` when the project already uses Kysely; pick `@duraflows/pg` when the project uses raw `pg`. Both implement the same interfaces and the conformance suite proves it.

### generateMigrationSql

```ts
import { generateMigrationSql } from "@duraflows/pg";

const { up, down } = generateMigrationSql(); // PG 13+ (gen_random_uuid)
const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" }); // PG 18+ (time-ordered)
```

### Database Schema

**workflow_instances:**

| Column               | Type          | Notes                       |
| -------------------- | ------------- | --------------------------- |
| `uuid`               | `uuid`        | PK, supplied by application |
| `workflow_name`      | `text`        | NOT NULL                    |
| `current_state`      | `text`        | NOT NULL                    |
| `version`            | `integer`     | NOT NULL, DEFAULT 0         |
| `expires_at`         | `timestamptz` | NULL if no timeout          |
| `last_transition_at` | `timestamptz` | NOT NULL                    |
| `context_json`       | `jsonb`       | NOT NULL, DEFAULT '{}'      |
| `metadata_json`      | `jsonb`       | NOT NULL, DEFAULT '{}'      |
| `created_at`         | `timestamptz` | NOT NULL                    |
| `updated_at`         | `timestamptz` | NOT NULL                    |

**workflow_history:**

| Column                   | Type          | Notes                                     |
| ------------------------ | ------------- | ----------------------------------------- |
| `uuid`                   | `uuid`        | PK, auto-generated                        |
| `workflow_instance_uuid` | `uuid`        | FK -> workflow_instances                  |
| `from_state`             | `text`        | NULL for creation                         |
| `event_name`             | `text`        | NOT NULL ("onEnter" for auto-transitions) |
| `to_state`               | `text`        | NOT NULL                                  |
| `outcome`                | `text`        | CHECK ('success', 'failure')              |
| `error_message`          | `text`        |                                           |
| `command_results_json`   | `jsonb`       | NOT NULL, DEFAULT '[]'                    |
| `trigger_metadata_json`  | `jsonb`       | NOT NULL, DEFAULT '{}'                    |
| `created_at`             | `timestamptz` | NOT NULL                                  |

**Indexes:**

- `workflow_instances_workflow_name_idx` on `(workflow_name)`
- `workflow_instances_expires_at_idx` on `(expires_at)` WHERE `expires_at IS NOT NULL`
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
- `metadata` write-once enforcement (v1.0.0 contract)
- Nested-transaction reuse via `transactionRunner`

Adapters that pass this suite are guaranteed to work with the runtime. `@duraflows/pg` and `@duraflows/kysely` both run it as part of their CI.

---

## Error Types

### WorkflowError (base)

```ts
class WorkflowError extends Error {
  constructor(message: string, cause?: unknown);
}
```

Thrown for: instance not found, optimistic lock failure, command not in registry.

### WorkflowDefinitionError

```ts
class WorkflowDefinitionError extends WorkflowError {
  readonly workflowName: string;
}
```

Thrown for: duplicate registration, validation failure, unknown workflow lookup.

### InvalidEventError

```ts
class InvalidEventError extends WorkflowError {
  readonly workflowInstanceUuid: string;
  readonly currentState: string;
  readonly eventName: string;
}
```

Thrown when: event not available on current state.

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
