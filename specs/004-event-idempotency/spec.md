# Plan: opt-in event idempotency

Status: Implemented and validated; pending release.

Baseline: duraflows 7.2.0. Target: the next lockstep minor release (7.3.0 if no intervening release).

## Goal and guarantee

Let callers retry a particular event request after an uncertain response without executing an already committed
request again. Scope a key to `(workflowInstanceUuid, idempotencyKey)`, independent of event name, state, and
definition version. Different instances may use the same key.

When the first request commits, a duplicate returns the recorded execution result. It does not evaluate guards,
execute commands or `onEnter` chains, update the instance, append history, or fire observers again. The result
describes the original execution; its `toState` is not necessarily the instance's current state.

State, context, history, and the idempotency record must participate in the same transaction, including caller-owned
transactions and nested savepoints. A rollback leaves the request retryable. Normal runtime initialization remains
a prerequisite; replay does not bypass startup validation.

This feature does not make external effects executed before a rollback exactly once, retry failed commands,
or provide durable observer delivery. Those need downstream idempotency or a separate outbox feature.

## API

```ts
await handle.triggerEvent("PaymentReceived", {
  subject: order,
  triggerMetadata: { source: "payment-webhook" },
  idempotencyKey: "payment:event_123",
  idempotencyFingerprint: "payment:pay_456:amount:2500:currency:USD", // optional
});

const persistence = pgWorkflowProviders(pool, { idempotency: true });
// Or: kyselyWorkflowProviders(db, { idempotency: true })
```

Add optional `idempotencyKey?: string` and `idempotencyFingerprint?: string` to
`TriggerWorkflowEventInput`, handle options, and the NestJS event DTO. The service already forwards the input;
verify its typed variant forwards the new fields too. Keep `WorkflowExecutionResult` unchanged: replay returns
the original `historyUuid`, outcomes, command results, and guard name. Do not add a required context or result field.

The implementation preserves arbitrary `subject` values and allows a caller-supplied fingerprint. It does not
require JSON subjects or hash them automatically:

- Always compare event names. Reusing a key for a different event is a conflict.
- Compare fingerprints exactly, including presence: omitted versus supplied is a conflict.
- When both fingerprints are omitted, the key identifies the request; duraflows does not detect changed subjects
  or metadata. Document this explicitly. Fingerprints should cover business inputs that affect execution.
- Do not implicitly hash or persist `subject` or `triggerMetadata`. Retry-specific metadata may legitimately change.
- Keys and fingerprints are case-sensitive opaque strings. Do not trim or normalize them. Accept nonblank strings
  of at most 256 UTF-8 bytes; reject NUL, null, wrong types, and a fingerprint without a key.
- A new business attempt, including reevaluating a rejected guard, requires a new key.

Keyed execution results cross a JSON persistence boundary. Normalize the first returned result and every replay
to the same JSON snapshot, including the standard treatment of dates, errors, and omitted properties. Capture
that snapshot before observers run. Reject serialization failures (such as cycles or BigInt) inside the transaction,
rolling back state, history, and the reservation. Arbitrary subjects remain allowed because they are not stored.
Return independent copies so caller mutation cannot change a stored receipt. Unkeyed result behavior is unaffected.

## Behavior matrix

| Situation                                                                         | Behavior                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| No key                                                                            | Existing event execution; no idempotency storage access                                     |
| First keyed request                                                               | Execute and atomically record the result                                                    |
| Matching duplicate                                                                | Return original result without executing again                                              |
| Same key, different event or fingerprint                                          | Throw `IdempotencyConflictError`                                                            |
| First execution returns `success`                                                 | Store and replay success                                                                    |
| First execution returns routed business `failure`                                 | Store and replay failure                                                                    |
| First execution returns `guard-rejected`                                          | Store and replay rejection; do not reevaluate                                               |
| Command throws, invalid event, or database rollback                               | No completed receipt; retry may execute                                                     |
| Outer transaction rolls back after the call returns                               | Receipt and workflow writes roll back together                                              |
| Concurrent duplicate                                                              | Wait for the existing instance lock; replay if its holder commits, execute if it rolls back |
| Same key reentered before the original execution finishes in the same transaction | Throw `IdempotencyInProgressError` rather than recursively execute                          |
| Keyed call without a configured store                                             | Throw `IdempotencyNotSupportedError` before executing commands                              |
| Instance advances or migrates after the original request                          | Replay receipt without resolving its current definition                                     |
| Instance no longer exists                                                         | Existing instance-not-found behavior                                                        |

A lock timeout retains its existing error behavior. `IdempotencyInProgressError` concerns transaction-local
reentrancy; ordinary concurrent callers do not receive it simply because another transaction is executing.

## Persistence contract and schema

Add optional `idempotencyStore?: WorkflowIdempotencyStore` to both `WorkflowPersistenceProvider` and
`WorkflowRuntimeOptions`. Do not extend required methods on existing stores.

The new interface should expose three transaction-required operations:

1. `find(instanceUuid, key)`: return a reservation/completed record or null.
2. `reserve({ instanceUuid, key, eventName, fingerprint })`: insert a transaction-local reservation; never overwrite.
3. `complete(instanceUuid, key, result)`: change that reservation to a completed receipt exactly once.

All operations must use the same connection and transaction as `lockByUuid`, instance writes, and history.
The caller must lock the instance before these operations. Reservations prevent recursive calls through other
runtime objects sharing the transaction from executing the same request twice. They are not durable worker claims:
no pending reservation may be committed by a successful `triggerEvent()` call, and errors roll it back.

Table: `workflow_event_idempotency`.

| Column                        | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `workflow_instance_uuid uuid` | Foreign key to instance; cascade on instance deletion |
| `idempotency_key text`        | Opaque key, exact comparison                          |
| `event_name text`             | Detect reuse for a different event                    |
| `fingerprint text null`       | Optional caller-provided request fingerprint          |
| `result_json jsonb null`      | Null only while reserved in the active transaction    |
| `created_at timestamptz`      | Receipt creation time                                 |

Use a composite primary key on instance UUID and key, exact text comparison (for example `COLLATE "C"`), and
database byte-length checks matching runtime validation. Keep event results separate from transition history:
one event can generate several history rows, and command-only events and guard rejections also need receipts.

No TTL, pruning API, or automatic deletion in the first release. Retain receipts for the life of the instance.
Document storage growth and that manually deleting a receipt removes its deduplication guarantee.

## Runtime flow

1. Validate optional key/fingerprint arguments and verify capability when a key is supplied.
2. Preserve initialization and the existing transaction/observer wrapper.
3. Lock the instance; keep existing missing-instance behavior.
4. For a keyed call, look up its record before current-state event validation or definition resolution.
5. Reject mismatched identity; reject a transaction-local unfinished reservation; otherwise return a completed copy.
6. On a miss, reserve the key inside this transaction.
7. Run existing definition resolution, guard evaluation, commands, transition, history, and the full `onEnter` chain.
8. Build the final result (including the guard-rejection branch), normalize it, and complete the receipt.
9. Commit through the existing transaction owner. Deliver observers through the existing path only for new execution.

Use a small shared completion helper so the guard-rejection early return cannot forget to persist its receipt.
Never catch a storage failure and proceed without idempotency. Custom adapters must actually implement transactional
storage; an in-memory receipt cache alongside durable workflow state does not provide this guarantee.

## Adapter and NestJS integration

- Add `PgWorkflowIdempotencyStore` and `KyselyWorkflowIdempotencyStore`, using the existing transaction contexts.
- Extend provider factory options with `idempotency?: boolean`, default false. Include the new store only when enabled.
- Add an optional options argument to `kyselyWorkflowProvidersFromTransaction(trx, options)` for the same capability.
- Keep existing `WorkflowDatabase` and its generic constraints compatible. Export a separate table type and an extended
  database interface for consumers opting in; use that type internally without requiring the table in existing schemas.
- Add migration `007_event_idempotency.sql` and a standalone `generateIdempotencyMigrationSql()` helper.
- Add `includeIdempotency?: boolean` to fresh-schema generation, default false. A default schema remains sufficient
  for default providers. Do not query or validate the new table at startup or on unkeyed calls.
- Wire an optional idempotency-store injection token through NestJS module construction for both `forRoot` and
  `forRootAsync`; persistence is currently passed via individual providers, not automatically spread into the runtime.
- Forward both DTO fields through the controller. Validate null explicitly: class-validator's `IsOptional` alone
  skips null. Start with JSON body fields; an `Idempotency-Key` HTTP header is deferred.
- Map conflict and transaction-local in-progress errors to HTTP 409, invalid arguments to 400, and missing capability
  to the existing sanitized 500 configuration-error path. Export new public types and errors consistently.

## Implementation sequence

1. Define API types, errors, receipt representation, and the optional persistence contract. Add conformance cases.
2. Implement schema helpers, migration, and both adapters, including transaction-bound Kysely providers.
3. Integrate keyed execution and result normalization into the runtime; preserve unkeyed behavior.
4. Add handle forwarding and NestJS wiring, validation, and HTTP behavior.
5. Update documentation, API reference, and all relevant repository skills alongside the feature.
6. Run validation and review compatibility before the minor release. Follow the repository's release process;
   do not manually generate changelog entries or bump versions during planning.

## Tests and acceptance criteria

### Runtime behavior

- A retry after a lost response returns the original result/history UUID; commands, guards, and observers run once.
- Replay still works after later transitions, definition changes, and instance migration. It does not rewind state.
- Same-state transitions and command-only events deduplicate, not just events that become unavailable afterward.
- Routed failures and guard rejections replay; a new key permits a deliberate new attempt.
- Event/fingerprint conflicts, malformed arguments, and missing capability execute no commands or guards.
- Command failure, `onEnter` failure, result serialization failure, and receipt write failure roll back all database writes.
- Outer rollback and failed nested savepoints remove their receipts; successful nested calls remain subject to outer commit.
- Reentry of the same instance/key through a shared transaction fails safely; different-key nested calls remain supported.
- Returned results cannot mutate stored receipts. First execution and replay have the same JSON representation.
- Unkeyed calls retain behavior and never access idempotency storage.

### Adapter and integration behavior

- Add `runIdempotencyStoreConformance` under `@duraflows/core/testing` for custom adapters: transaction requirements,
  reservation/complete round trips, immutable completion, exact comparison, and rollback/savepoint behavior.
- Exercise both adapters against real PostgreSQL with separate pooled connections. Race duplicate commits and rollbacks,
  verify one committed execution and receipt, and include different instances using the same key. Mocks cannot prove locking.
- Verify migration `007` from the existing schema and fresh-schema generation with and without the optional table.
- Verify factory defaults and explicit opt-in, including transaction-bound Kysely providers and consumer type compatibility.
- Verify NestJS synchronous/asynchronous module setup, DTO forwarding, real HTTP replay and 409 responses, and null handling
  on the supported NestJS versions.
- Keep existing custom-provider and execution-context fixtures compiling without adding required fields.

Implementation validation: `pnpm run build`, `pnpm run lint`, `pnpm run format:check`, `pnpm run typecheck`, and
`pnpm run test:coverage`; real database suites with `DATABASE_URL` and `REQUIRE_INTEGRATION_DB=1`; existing NestJS
compatibility checks. Reuse existing CI jobs rather than adding a second database test infrastructure.

## Documentation and skills are required deliverables

These resources were updated with the implementation; examples use the implemented API. Package versions remain
unchanged until the repository's release process runs.

| Resource                                        | Required update                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Root README and core/NestJS package READMEs     | Opt-in feature summary, stable-key example, guarantee and limits                            |
| pg/Kysely package READMEs                       | Factory options, optional migration, transaction-bound providers, deployment sequence       |
| `docs/getting-started.md`                       | Webhook/network-retry example with a stable upstream event ID                               |
| `docs/core-runtime.md`                          | Inputs, scope, fingerprints, JSON results, replay, reentrancy, and all outcome semantics    |
| `docs/persistence.md`                           | Optional store contract, schema, transaction requirements, conformance suite, retention     |
| `docs/nestjs-integration.md`                    | Module setup, JSON request body, validation, errors, and typed service forwarding           |
| `docs/error-handling.md`                        | New error classes, conflicts, unsupported adapters, rollback and retry guidance             |
| `references/api-reference.md`                   | All new exports, signatures, options, types, and errors                                     |
| `skills/duraflows-developer/SKILL.md`           | API and guarantees; no-key behavior; committed receipts versus external effects             |
| `skills/duraflows-builder/SKILL.md`             | Generate stable per-occurrence keys for retryable inputs; explain guard retry keys          |
| `skills/duraflows-persistence-adapter/SKILL.md` | Optional interface, shared transaction, reservation/completion, schema and tests            |
| `skills/duraflows-tester/SKILL.md`              | Duplicate/replay, conflict, concurrency, rollback, and serialization test patterns          |
| `skills/duraflows-reviewer/SKILL.md`            | Check key identity, fingerprint coverage, atomic receipts, migrations, and external effects |

Update linked skill resources if present and affected. Validate skill Markdown/frontmatter and code examples using
the repository's established checks. Repository skills are the source deliverables; installing copies into a user's
global skills directory is a separate action, not required to implement the library feature.

All docs and skills must agree on scope, fingerprint limitations, permanent guard/business-failure receipts, lack of
automatic pruning, and JSON result normalization. Update `CLAUDE.md` if its generated technology/schema summary is
regenerated as part of the feature work.

## Deployment and review

Deploy in this order: additive migration, supporting code, then explicit opt-in at providers/call sites. Old workers
can continue using existing tables, but callers must route keyed requests only to workers that support them.
Old application builds will reject the new HTTP body fields, and old direct callers cannot provide the guarantee;
finish the application rollout before enabling incoming keyed traffic.

Release as a minor only if existing adapters, Kysely consumer types, unkeyed requests, and defaults remain compatible.
Acceptance includes the documentation and skill updates above, not just passing runtime tests.

## Implementation validation

- Dual ESM/CommonJS build, lint, formatting, and type checks pass, including existing and extended Kysely consumer schemas.
- The coverage suite passes with 969 tests and 100% function coverage; its three database suites are intentionally
  skipped without `DATABASE_URL` and were exercised separately.
- All 135 real PostgreSQL integration cases pass, including duplicate commit/rollback races, caller-owned
  transactions, savepoints, reentry, migration `007`, and instance deletion cascades.
- Packed CommonJS and ESM consumers pass real HTTP execution/replay/conflict/validation checks with NestJS 11.0.0
  and 12.1.0 on Node 22. The existing CI compatibility matrix covers the supported Node/NestJS combinations.
- All five repository skills pass frontmatter validation; their evaluation fixtures include the new feature.
- A keyed request snapshots its input identity so caller mutation during command execution cannot leave an
  unfinished reservation or change the receipt's key/event/fingerprint.
