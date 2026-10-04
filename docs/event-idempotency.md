# Event idempotency

Event idempotency lets you safely retry an event after losing its response. A stable key identifies one request
on one workflow instance. Once that request commits, retries return its recorded result without running the event again.

## Enable persistence

Apply `007_event_idempotency.sql` from `@duraflows/pg` before enabling the feature. It adds the optional
`workflow_event_idempotency` table and works for both bundled PostgreSQL adapters. Existing deployments that do
not enable idempotency do not need this migration.

```ts
import { pgWorkflowProviders, generateIdempotencyMigrationSql } from "@duraflows/pg";

const { up, down } = generateIdempotencyMigrationSql(); // Put in your migration tool.
const persistence = pgWorkflowProviders(pool, { idempotency: true });
```

For a fresh schema, `generateMigrationSql({ includeIdempotency: true })` includes the table. The default remains
false. Kysely supports `kyselyWorkflowProviders(db, { idempotency: true })` and
`kyselyWorkflowProvidersFromTransaction(trx, { idempotency: true })`. Its exported
`WorkflowDatabaseWithIdempotency` adds the table to `WorkflowDatabase`; existing database types remain valid.

Pass these providers to `WorkflowRuntime` or `WorkflowModule.forRoot` / `forRootAsync` as usual. There is no
extra NestJS feature flag. A keyed call without `idempotencyStore` throws `IdempotencyNotSupportedError`;
an unkeyed call never accesses the optional table, even when the store is configured.

## Give each occurrence a stable key

```ts
const result = await handle.triggerEvent("PaymentReceived", {
  subject: order,
  idempotencyKey: "payment-provider:event_123",
  idempotencyFingerprint: "payment:pay_456:amount:2500:currency:USD", // Optional.
  triggerMetadata: { source: "webhook" },
});
```

Use an upstream webhook/message ID, or generate a request ID once and keep it across retries. Two distinct
occurrences need different keys, even when they invoke the same event. Do not generate a fresh UUID on every retry
or use only the event name as the key.

The identity is `(workflowInstanceUuid, idempotencyKey)`, not the current state or definition version. Different
instances can use the same key. Keys and fingerprints compare exactly, including case, spaces, and Unicode
normalization. They must be nonblank valid Unicode strings, at most 256 UTF-8 bytes, without NUL. Null is invalid.
The runtime preserves valid strings as supplied and rejects a fingerprint without a key.

## Fingerprints and conflicts

Reusing a key for a different event always throws `IdempotencyConflictError`. Fingerprints compare exactly,
including presence: supplying a fingerprint on the first call and omitting it on a retry is a conflict.

The runtime does not automatically serialize or hash subjects or metadata. Subjects can remain arbitrary objects.
When both calls omit the fingerprint, changed inputs are not detected; the key asserts that they are the same request.
Supply a fingerprint derived from all business inputs that affect execution when you need to detect conflicting reuse.
Retry-specific metadata, such as the current tracing span, need not be included unless it affects business behavior.

## Recorded outcomes and replay

| First execution                                                          | Same-key retry                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| Committed `success`                                                      | Original success result                          |
| Committed routed business `failure`                                      | Original failure result                          |
| Committed `guard-rejected`                                               | Original rejection; the guard is not reevaluated |
| Exception, invalid event, serialization failure, or transaction rollback | No completed receipt; a later retry may execute  |

A new attempt to reevaluate a guard or retry a committed business failure needs a new key. A retry returns the
original `historyUuid`, `fromState`, `toState`, command results, and guard name. Its `toState` may differ from the
instance's current state if it advanced or migrated afterward; use `getInstance()` to read current state.

Replay does not run guards, commands, or `onEnter` chains, append history, update state/context/timeouts, or fire
observers. Normal runtime initialization still applies. Receipts are checked before resolving the instance's
current definition or validating event availability, so state changes do not make completed requests invalid.

For keyed calls, both the first result and replay are JSON snapshots: dates become strings, error objects follow
their JSON representation, and undefined object fields are omitted. Circular values and BigInt that cannot be
serialized fail the transaction. The subject itself is not stored. Returned results are independent copies.
Unkeyed calls retain their existing result behavior.

## Transactions and concurrency

The runtime locks the instance, checks/reserves the key, executes the event and its complete `onEnter` chain,
and stores the result in one transaction. A concurrent duplicate waits for the lock. If the first transaction
commits, it replays; if the first rolls back, it may execute. Existing lock-timeout settings apply.

Receipts participate in caller-owned transactions and nested savepoints. A call that returns inside an outer
transaction is not durable until that transaction commits. An outer rollback removes both its workflow writes
and receipt. Same-key recursive execution in that transaction throws `IdempotencyInProgressError` rather than
executing again. Different keys remain subject to ordinary transaction and optimistic-locking constraints.

An HTTP call uses the optional fields in the JSON body:

```json
{
  "idempotencyKey": "payment-provider:event_123",
  "idempotencyFingerprint": "payment:pay_456:amount:2500:currency:USD",
  "subject": { "orderId": "ORD-123" },
  "triggerMetadata": { "source": "webhook" }
}
```

Send it to `POST /workflows/:workflowInstanceUuid/events/:eventName`. First execution and replay use the existing
201 response and result shape. Conflict/reentry errors map to 409, invalid fields to 400, and missing capability
to a sanitized 500. An `Idempotency-Key` header is not supported; put the key in the body.

## Custom adapters

Add optional `idempotencyStore: WorkflowIdempotencyStore` to your persistence provider. All three methods require
the same active transaction/connection as the workflow instance lock, state updates, and history writes:

```ts
interface WorkflowIdempotencyStore {
  find(workflowInstanceUuid: string, key: string): Promise<WorkflowIdempotencyRecord | null>;
  reserve(input: WorkflowIdempotencyReservation): Promise<void>;
  complete(workflowInstanceUuid: string, key: string, result: WorkflowExecutionResult): Promise<void>;
}
```

`WorkflowIdempotencyReservation` contains `workflowInstanceUuid`, `key`, `eventName`, and optional `fingerprint`.
`WorkflowIdempotencyRecord` adds `createdAt: Date` and `result: WorkflowExecutionResult | null`.
Null represents a reservation inside an unfinished transaction, not a worker lease. `reserve` must never overwrite
an existing row; `complete` must reject a missing or already completed reservation. Never commit an unfinished
reservation from a successful event call. A separately committed cache cannot satisfy this contract.

If your runner allows an outer transaction to catch a failed nested call and continue, use savepoints or equivalent
rollback isolation. Flat nesting alone cannot remove that failed call's reservation and workflow writes safely.

Use `runIdempotencyStoreConformance(label, harness)` from `@duraflows/core/testing`. The harness supplies fresh
storage, a transaction runner, an existing instance UUID, `withInstanceLock(work)` that runs under its transaction
and lock, and teardown. Also test real concurrent connections; conformance alone does not establish lock safety.

## Retention, deployment, and external effects

Receipts remain for the life of the instance. The bundled schema cascades their deletion when the instance is
deleted. There is no automatic expiry or cleanup API. Account for storage growth; manually deleting a receipt
removes its deduplication guarantee.

Apply the additive migration, deploy supporting code to every application worker that can receive keyed requests,
then enable provider/call-site configuration. Old application builds may reject new HTTP fields or ignore keys in
direct calls, so finish the rollout before enabling incoming keyed traffic.

This feature protects completed, committed event executions. If a command charges a card and the transaction
later rolls back, that charge may already exist while the receipt does not. Use a stable downstream idempotency
key for such effects. `transitionUuid` is generated per execution and is not a stable retry key. Event idempotency
does not provide command checkpoints, automatic retries, or reliable delivery of observer callbacks.
