# Durable command progress

Use `enqueueEvent()` when an event runs several commands and must resume after a process crash without repeating commands that already have committed checkpoints. For example, a successful payment command can remain checkpointed while inventory reservation is retried. The existing `triggerEvent()` API retains its single-transaction behavior.

## Enable the feature

Apply optional migration `008_durable_execution.sql` from `@duraflows/pg/sql/dbmate`, or run the `up` SQL returned by `generateDurableExecutionMigrationSql()`. For a fresh database, use `generateMigrationSql({ includeDurableExecution: true })`. Migration 008 does not depend on optional event-idempotency migration 007.

Enable the store on **every runtime accessing these instances**, including synchronous callers, migration jobs and timeout pollers:

```typescript
const persistence = pgWorkflowProviders(pool, { durableExecution: true });
// Or: kyselyWorkflowProviders(db, { durableExecution: true })

const runtime = new WorkflowRuntime({
  ...persistence,
  definitionRegistry,
  commandRegistry,
  clock: { now: () => new Date() },
  durableExecution: {
    leaseDurationMs: 30_000,
    initialDelayMs: 1_000,
    maxDelayMs: 3_600_000,
    maxAttempts: 10,
  },
});
```

Deploy the migration first, then upgrade and enable all runtimes before accepting queued events. Old workers, or workers without `executionStore`, cannot enforce the active-execution check. These are opt-in additions: existing applications and custom adapters do not need the new table or store to keep using synchronous events.

## Accept work and run workers

```typescript
const execution = await runtime.enqueueEvent({
  workflowInstanceUuid,
  eventName: "Submit",
  idempotencyKey: "order-42:submit",
  idempotencyFingerprint: "order-42:revision-3",
  subject: { orderId: "order-42" },
});

// Run periodically in your own worker/scheduler, outside any transaction.
const batch = await runtime.processPendingExecutions({ limit: 100 });
const current = await runtime.getExecution(execution.uuid);
```

`WorkflowHandle.enqueueEvent(eventName, options)` is also available. Acceptance persists the request; it does not run commands. A poll processes at most one command per selected execution, including commands in the resulting `onEnter` chain. Keep polling to make progress; there is no built-in daemon. Zero-command events finalize during a poll. Polls process their candidate list sequentially; separate worker processes can handle different instances concurrently.

The result reports `processed` (claimed executions), and execution UUID arrays `progressed`, `completed`, `retrying`, `parked`, `skipped`, plus `failed: { uuid, error }[]` for errors the worker could not record as a retry. Monitor parked and failed work. A live lease makes an execution ineligible; a race after selection can put it in `skipped`.

Keys are required, opaque, instance-scoped, nonblank strings of at most 256 UTF-8 bytes, without NUL or malformed Unicode. An optional fingerprint follows the same validation. Repeating the same key/event/fingerprint returns the current execution, including completed, cancelled and guard-rejected records. A different event or fingerprint raises `IdempotencyConflictError`. Input payloads are not hashed automatically. Queued keys have a separate namespace from `triggerEvent()` receipts; using the same key with both APIs does not deduplicate across them.

The subject and trigger metadata must be plain JSON data. Functions, class instances, Dates, bigint, cycles, nonfinite numbers, and nested `undefined` are rejected. Input is copied at acceptance. Omitting `subject` passes `undefined` to guards and commands, including entry commands; explicit `null` remains `null`. Handlers receive a frozen subject and immutable metadata; mutate `ctx.context` for recoverable workflow data. Checkpoints store JSON snapshots of command results and context, so keep these JSON-compatible too.

Guards run during acceptance in its transaction and must remain pure. A guard rejection immediately produces a completed execution and history row. An accepted guard is never rerun by the worker. Enqueue can join an application transaction: the execution is visible to workers only after that transaction commits and disappears on rollback.

## External commands and database commands

External commands execute outside the workflow transaction by default. Pass the stable command identity to the downstream service:

```typescript
const charge = {
  async execute(subject, ctx) {
    const payment = await payments.charge(subject.orderId, {
      idempotencyKey: ctx.durable.idempotencyKey,
    });
    ctx.context.paymentId = payment.id;
    return { ok: true };
  },
};
```

`ctx.durable` is present only for queued execution. Its fields are `executionUuid`, `commandId` (zero-based occurrence ordinal), `idempotencyKey` (`executionUuid:commandId`), `attempt` (one-based), and `heartbeat()`. Repeated uses of the same command name get different occurrence IDs. The ID remains stable across retries and worker replacement. `ctx.now` is the acceptance time, and transition UUIDs are stable across recovery. A handler shared with synchronous events must handle `ctx.durable === undefined` and provide its own stable synchronous idempotency key.

A crash after the external service succeeds but before checkpoint commit can cause that command to run again. **Delivery is at least once; downstream idempotency is necessary to prevent duplicate effects.** Lease fencing prevents a stale worker from saving a checkpoint, but cannot stop its already-running network request. Configure service timeouts and use downstream deduplication with retention long enough for your retry/operator recovery window.

For short database-only commands, set `transactional: true` on the command reference:

```typescript
commands: [{ name: "reserveInventory", transactional: true }, { name: "sendConfirmation" }];
```

The first command runs in the same transaction and connection as its checkpoint. Use `PgTransactionContext.getClient(pool)` or `KyselyTransactionContext.getTransaction(db)` with the **same** pool/database used by the provider. An error propagated out of command execution, or a checkpoint/finalization failure, rolls those database writes back together. A returned `{ ok: false }` is a recorded business outcome: its database writes commit with that checkpoint, whether it routes to `errorState` or parks for a missing error route. A best-effort handler's thrown JavaScript error is converted into a recorded failure, so any earlier writes may commit too. Earlier successful commands remain committed. Avoid external calls or long computation in transactional commands: their instance lock remains held throughout. The flag also works on `onEnter` command references; synchronous events already execute all their commands transactionally.

Long external commands must call and await `ctx.durable.heartbeat()` before the lease expires. There is no automatic heartbeat or handler cancellation. An expired owner cannot extend its lease or checkpoint, and another worker may start the same command. Workers use the supplied clock, so synchronize machine clocks. Transactional commands must also finish within their lease or extend it; their heartbeat is visible to other connections only on transaction commit.

## State, failures and recovery

The execution journal advances after each checkpoint. The instance's state, context and transition history remain at the pre-event values until the entire event and entry chain finish. Read `getExecution()` to inspect partial progress. Final state changes, per-hop history rows, the completed execution and instance context commit together. Observers fire after that commit with their existing best-effort semantics; they are not a durable delivery channel. If finalization fails, the last uncommitted command may be retried with the same downstream key.

A pending, running or parked execution occupies its instance. New synchronous events, different queued events, timeout rearming and applying instance migrations are blocked with `WorkflowInstanceBusyError`; timeout sweeps skip it. Already-completed synchronous receipt replays still work. `getAvailableEvents()` continues to describe the state's events and does not express execution availability. Only one active queued execution per instance is supported; this API does not buffer multiple future events.

Thrown errors retry the unfinished command with exponential backoff, capped at `maxDelayMs`. After `maxAttempts` attempts it parks; repeated lease expirations count toward that limit too. Each successful checkpoint resets the attempt counter for the next command. Runtime-generated persisted diagnostics (`lastError` and converted best-effort exception messages) replace NUL and unpaired UTF-16 surrogates with U+FFFD and are limited to 2,000 UTF-16 code units without splitting a surrogate pair. Application payloads and returned business results are not sanitized. All four policy values must be positive safe integers; `maxDelayMs` must be at least `initialDelayMs`. The accepted execution captures the policy.

A mandatory `{ ok: false }` uses the definition's `errorState`, including its compensation `onEnter` commands. Without an error route, the failed result is checkpointed and the execution parks. Best-effort command failures are checkpointed and allow the next command to proceed. Previous effects are never automatically undone.

```typescript
await runtime.retryExecution(executionUuid); // Parked work only; resets attempts.
await runtime.cancelExecution(executionUuid); // Pending, parked, or expired lease.
```

Retry preserves the journal: it retries interrupted infrastructure work, not a recorded business outcome. Retrying an unrouted business failure cannot erase that outcome; use cancellation and a modeled recovery event. Cancellation refuses a live lease, completed execution or already-cancelled execution. It releases the instance but does not reverse committed commands or stop an external request still running after lease expiry. Reusing a cancelled request's key returns its cancelled record; a new request needs a new key.

Definitions, initial inputs, best-effort flags and the entry-chain depth limit are captured at acceptance. Recovery reconstructs the declarative path using recorded results; it does not rerun completed handlers. Keep compatible command handlers registered for all unfinished executions. `listDefinitionVersions()` counts pending, running, and parked snapshots in `activeInstances`, together with nonterminal stamped instances, counting each instance once per version. A v1 instance with a queued v2 execution retains both versions until work finishes or is cancelled. Stop producers accepting the old version before using a zero count to retire handlers. This is command-boundary recovery, not arbitrary JavaScript replay: there are no checkpoints inside a handler, automatic compensation, durable sleeps, signals, or child workflows.

Execution records retain their subject, definition and command/context snapshots indefinitely. Budget storage for these payloads and avoid secrets in them. There is no pruning API; deleting records removes request deduplication and deleting active records loses recovery state. Drain queued work before disabling the feature or reverting its migration.

## NestJS

Pass a provider with `durableExecution: true` as `persistence` in `WorkflowModule.forRoot()` or `forRootAsync()`, and optionally configure the `durableExecution` policy alongside it. `WorkflowService` exposes the same five operations. `WORKFLOW_EXECUTION_STORE` is exported for injection (it resolves to `null` when disabled).

With controllers enabled, the routes are:

| Method | Route                                                    | Purpose                                                                                            |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| POST   | `/workflows/:workflowInstanceUuid/executions/:eventName` | Enqueue; JSON body requires `idempotencyKey`, optionally subject, trigger metadata and fingerprint |
| GET    | `/workflows/executions/:executionUuid`                   | Inspect progress; 404 if missing                                                                   |
| POST   | `/workflows/executions/process?limit=100`                | Process one batch                                                                                  |
| POST   | `/workflows/executions/:executionUuid/retry`             | Retry parked execution                                                                             |
| POST   | `/workflows/executions/:executionUuid/cancel`            | Cancel eligible execution                                                                          |

Use the application's authentication and authorization for these routes, as with other optional duraflows controllers. Busy instances and lease conflicts map to HTTP 409.

## Custom persistence adapters

Implement optional `WorkflowExecutionStore` and expose it through `WorkflowPersistenceProvider.executionStore`. Insert/update use the active transaction and the locked instance's connection. Enforce unique `(workflowInstanceUuid, idempotencyKey)`, one pending/running/parked execution per instance, and optimistic revisions (`stored revision === incoming revision - 1`). Reads must see that same transaction's writes and return independent JSON copies. `findDue()` orders by availability then UUID and selects pending/running executions whose availability and absent/expired lease permit work; selection is a hint rechecked under lock.

The instance store must honor `findExpired(limit, now, { excludeActiveExecutions: true })`: exclude pending/running/parked executions before applying the limit, so occupied instances cannot starve unrelated timeout work. The runtime only passes this option when an execution store is enabled; legacy adapters without queued execution are unchanged.

The runner must implement `isTransactionActive(): boolean` for worker processing. `processPendingExecutions()` rejects a missing detection capability or an ambient transaction because command checkpoints must commit independently. Existing custom runners can leave the optional method absent if they do not run durable workers. Kysely providers bound to a caller-owned transaction support enqueue but cannot process workers; use ordinary providers outside that transaction for processing.

For version retirement inspection, implement optional `countInstancesUsingDefinition({ workflowName, definitionVersion, excludeStates }): Promise<number>`. In one consistent read, count the distinct union of nonterminal instances stamped with the version and instances owning pending/running/parked executions captured under it. Match workflow name and treat an omitted captured definition version as 1. Apply `excludeStates` only to the stamped-instance branch. Both bundled adapters support this method. A custom store can omit it for normal execution, but `listDefinitionVersions()` then throws instead of reporting incomplete retirement counts. No additional migration is required.
