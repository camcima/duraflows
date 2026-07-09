# Duraflows Architecture Review — 2026-07-09

## Scope and method

This review covers the current implementation of every publishable package in
the monorepo:

- `@duraflows/core`
- `@duraflows/pg`
- `@duraflows/kysely`
- `@duraflows/nestjs`

I inspected production source, migrations, package manifests, build and
release configuration, public documentation, and test suites. I also ran the
normal quality gates and small runtime probes for the findings marked
**reproduced** below.

There are no standalone deployable applications in this repository; the four
packages are the applications/product surface reviewed here.

Severity uses the following meaning:

- **High** — can silently violate data isolation or integrity in a valid
  supported deployment.
- **Medium** — produces incorrect externally observable behaviour, misleading
  operations data, or a material reliability failure.
- **Low** — configuration, documentation, or API-quality issue that is
  unlikely to corrupt data on its own.

## Executive assessment

The implementation is generally well structured. The core runtime is cleanly
separated from persistence, uses row locking plus optimistic versions, freezes
registered definitions, has deliberate command/guard semantics, and is backed
by unusually strong automated coverage. The PostgreSQL and Kysely adapters are
close in behaviour, and the NestJS integration keeps its REST endpoints
opt-in.

The most important issue is that both persistence adapters use a module-global
`AsyncLocalStorage` transaction context. An active transaction for one
provider is therefore treated as the active transaction for every provider of
the same adapter type. In a multi-database, multi-tenant, or read/write-split
application this can silently send workflow writes to the wrong database.

Address the high-severity transaction-context issue before relying on multiple
providers in one Node process. Then correct the observer and timeout result
semantics, which otherwise make post-commit failures and timeout processing
misleading to callers and operators.

## Findings

### AR-01 — Global transaction context leaks across provider instances

**Severity:** High  
**Affected packages:** `@duraflows/pg`, `@duraflows/kysely`

Both adapters put the current connection/transaction in one module-global
`AsyncLocalStorage` instance:

- `packages/duraflows-pg/src/pg-transaction-context.ts:4`
- `packages/duraflows-kysely/src/kysely-transaction-context.ts:5`

Their stores then unconditionally prefer that global value over the pool or
Kysely object that was supplied to the store:

- `packages/duraflows-pg/src/pg-instance-store.ts:9-11`
- `packages/duraflows-pg/src/pg-history-store.ts:8-10`
- `packages/duraflows-kysely/src/kysely-instance-store.ts:10-12`
- `packages/duraflows-kysely/src/kysely-history-store.ts:9-11`

The transaction runners likewise regard _any_ stored context as an existing
transaction (`pg-transaction-runner.ts:10-13` and
`kysely-transaction-runner.ts:10-13`). They do not verify ownership.

**Impact:** If runtime A is executing inside a transaction for database A and
code invokes runtime B, configured with database B, runtime B's stores use the
transaction client for database A. This defeats the provider binding and can
write/read the wrong tenant or database. `kyselyWorkflowProvidersFromTransaction`
has the same problem: an unrelated active context overrides the transaction it
was explicitly bound to.

**Evidence:** Reproduced with two fake `pg` pools. Calling a store constructed
with pool B from a transaction runner constructed with pool A made all queries,
including the store query, execute on A's client.

**Recommendation:** Make transaction context provider-scoped. A practical
design is for each provider factory to create one private context object and
pass it to its runner and stores. Alternatively, store a `{ owner, client }`
record and only reuse it when `owner` is the same pool/Kysely instance. Keep a
public helper only if it accepts the provider/context explicitly. Add tests for
two independent providers, nested runtimes, and the pre-bound Kysely factory.

### AR-02 — A throwing observer error handler breaks the documented containment boundary

**Severity:** Medium  
**Affected packages:** `@duraflows/core`, transitively `@duraflows/nestjs`

`ObserverRegistry.fireOnEnter()` catches an observer failure, but invokes the
user-supplied `onObserverError` handler outside a second `try`/`catch`
(`packages/duraflows-core/src/runtime/observer-registry.ts:27-34`). If that
handler throws, the runtime call rejects after the workflow transaction has
already committed and no later observers execute.

This contradicts the public contract, which says observer errors are
error-contained and do not affect runtime correctness:

- `references/api-reference.md:491-494`
- `docs/core-runtime.md:987-990`

**Evidence:** Reproduced with an observer that throws and an `onObserverError`
handler that throws. `createInstance()` rejected with the handler error while
the new instance was already persisted.

**Recommendation:** Guard `onObserverError` itself. If it fails, log through a
minimal safe fallback and continue with the remaining observers. Add a unit
test asserting that a throwing error handler neither rejects a completed
transition nor prevents the next observer.

### AR-03 — Timeout processing reports a failed on-enter chain as a successful item

**Severity:** Medium  
**Affected packages:** `@duraflows/core`, surfaced by `@duraflows/nestjs`

`processTimeoutEvent()` awaits `processOnEnterChain()` and discards its result
(`packages/duraflows-core/src/runtime/workflow-runtime.ts:483-486`). Therefore,
if a timeout event successfully reaches a state whose `onEnter` command returns
`{ ok: false }` and routes to `errorState`, the batch result increments
`processed` and leaves `failed` empty.

`triggerEvent()` treats the corresponding on-enter failure as an overall
`"failure"` (`workflow-runtime.ts:294-303`), while the timeout API documents
`processed` as instances whose timeout event transitioned successfully
(`docs/core-runtime.md:217-221`). The batch result gives operators no signal
that the workflow ended on its error path.

**Evidence:** Reproduced a timeout transition whose destination on-enter routed
to `failed`. The returned result was `{ processed: 1, rejected: 0, failed: [] }`,
while the instance ended in `failed` and history contained `success,failure`.

**Recommendation:** Define the batch outcome contract explicitly and preserve
the final chain outcome. For example, add a `businessFailed` collection/count
separate from infrastructure `failed`, or make `processed` mean "attempted" and
return per-item final outcomes. Ensure scheduler metrics and the Nest timeout
endpoint expose the distinction.

### AR-04 — Timeout validation accepts `NaN` and infinity

**Severity:** Medium  
**Affected package:** `@duraflows/core`

`WorkflowValidator.validateTimeout()` rejects values only when `value <= 0`
(`packages/duraflows-core/src/validation/workflow-validator.ts:234-243`). Both
`NaN` and `Infinity` pass that check because they are numbers and neither is
less than or equal to zero. `TimeoutResolver` then silently disables a `NaN`
duration or creates `Invalid Date` for infinity
(`packages/duraflows-core/src/execution/timeout-resolver.ts:34-39`).

**Evidence:** Reproduced: definitions containing `afterMinutes: NaN` and
`afterMinutes: Infinity` validate successfully. The former returns no deadline;
the latter returns `Invalid Date` and will fail or behave inconsistently in a
persistence adapter.

**Recommendation:** Require `Number.isFinite(value) && value > 0` in the
validator and consider `Number.isSafeInteger(value)` if fractional timeouts are
not an intended API. Add explicit unit cases for `NaN`, `Infinity`,
`-Infinity`, and numeric overflow.

### AR-05 — Public batch and history pagination inputs are not validated

**Severity:** Low  
**Affected packages:** `@duraflows/core`, `@duraflows/pg`, `@duraflows/kysely`

The HTTP DTOs validate timeout and history pagination values, but the public
core API passes values unchanged:

- `workflow-runtime.ts:318-329` forwards `ProcessExpiredWorkflowsInput.limit`
  directly to the adapter.
- `workflow-runtime.ts:602-607` forwards history `limit` and `offset` directly
  to the adapter.
- Both adapters pass those values to SQL/Kysely limit and offset calls.

Library users commonly call `WorkflowRuntime` or `WorkflowHandle` directly,
where `0`, negative values, non-integers, `NaN`, and unboundedly large values
are not rejected consistently. At best this causes driver errors; at worst it
turns a batch/paginated read into an unexpectedly expensive operation.

**Recommendation:** Validate these values at the core boundary: positive safe
integer for batch/history limits and non-negative safe integer for offsets.
Use a documented maximum or a configurable maximum for operationally sensitive
batch reads. Keep the DTO validation as defence in depth.

### AR-06 — Timeout-processing documentation describes an obsolete transaction model

**Severity:** Low  
**Affected package:** `@duraflows/core` documentation

`docs/core-runtime.md:199-205` says timeout processing finds and processes all
items in one transaction. The implementation intentionally changed to a short
scan transaction followed by one transaction per stale instance
(`packages/duraflows-core/src/runtime/workflow-runtime.ts:326-372`). The code's
approach is safer for lock duration and failure isolation, but the documentation
now gives integrators the wrong transaction and concurrency model.

**Recommendation:** Update the documentation to describe the two-phase scan,
fresh re-lock, per-instance transaction, and post-commit observer sequence.
This should also explain why the re-check of `expiresAt` is required.

## Package observations and improvement opportunities

### `@duraflows/core`

**What is working well**

- The core/persistence split is strong: stores and transaction runners have
  precise contracts, and PostgreSQL implementations correctly combine row
  locks with version checks.
- The command, guard, on-enter, timeout, compiler, and observer responsibilities
  are well separated. The validator catches missing states, duplicate timeouts,
  unresolved registered commands/guards, cycles, and unreachable states.
- Runtime timestamps come from an injected clock, and command/observer inputs
  are cloned and frozen where immutability matters.
- The reusable `WorkflowInstanceStore` conformance suite is a good foundation
  for additional adapter implementations.

**Improvements**

- For critical post-commit integrations, introduce an outbox or durable event
  dispatcher. Observers are deliberately at-most-once and run serially after
  commit. A process crash between commit and callback loses the notification;
  a slow observer also lengthens the caller's response time. This is clearly
  documented, so it is an architectural trade-off rather than a hidden bug.
- Enforce JSON-compatible context, metadata, trigger metadata, and command
  results at a documented boundary or provide a configurable serializer. The
  API types accept `unknown`, while the built-in adapters use `JSON.stringify`.
  Invalid/cyclic values therefore fail late, after command work has begun.
- Make `maxOnEnterDepth` a validated positive integer. A zero, negative,
  fractional, or non-finite value makes the protection confusing or ineffective.
- The deep-freeze utility specifically protects `Map` and `Set`, but `Date` and
  other mutable built-ins can still mutate their internal slots after
  `Object.freeze`. Either validate the documented JSON-only constraint or
  broaden the immutability strategy.

### `@duraflows/pg`

**What is working well**

- Queries are parameterized, updates use the documented previous-version
  condition, expired scans use `FOR UPDATE SKIP LOCKED`, and history ordering
  is deterministic with `created_at DESC, uuid DESC`.
- The migration generator and shipped dbmate migrations include the required
  history indexes and guard-rejection columns. The package contents check shows
  SQL and both ESM/CJS outputs are included.

**Improvements**

- Resolve AR-01 by binding transaction context to the pool/provider instance.
- Preserve the original error if `COMMIT` or `ROLLBACK` fails. The current
  catch block unconditionally awaits `ROLLBACK` (`pg-transaction-runner.ts:21-23`),
  so a rollback failure can mask the causative error and impede diagnosis.
- Consider a composite or partial index tailored to the operational lookup
  patterns once query volumes are known. The existing indexes are a sound
  baseline; no speculative index should be added without production plans.

### `@duraflows/kysely`

**What is working well**

- The adapter preserves the same locking, optimistic-version, history-ordering,
  and JSON semantics as the `pg` adapter.
- The generic provider factory supports intersection database schemas without
  leaking workflow-table assumptions into application schema types.

**Improvements**

- Resolve AR-01. It is especially important for
  `kyselyWorkflowProvidersFromTransaction()`: the explicit transaction should
  not be silently superseded by an unrelated ambient transaction.
- Keep the adapter contract test suite in lockstep with `pg`, including
  cross-provider context tests. Today the ordinary adapter tests demonstrate
  one database/context only, which cannot detect this class of isolation bug.

### `@duraflows/nestjs`

**What is working well**

- Controllers are disabled by default. When enabled, DTOs apply whitelist and
  numeric/UUID validation, and the package documentation prominently warns
  that consumers must add authentication and rate limiting.
- The module validates command and built-in guard registrations during bootstrap,
  supports async construction, and maps normal domain errors to useful HTTP
  statuses without exposing generic internal errors.
- Command discovery and explicit registration collision detection are clear and
  easy to reason about.

**Improvements**

- Expose `maxOnEnterDepth` through both `WorkflowModule.forRoot()` and
  `forRootAsync()` so Nest users can tune the safety control already available
  in `WorkflowRuntime`.
- `WorkflowModule` is always global and uses the fixed string token
  `"WORKFLOW_MODULE_OPTIONS"` (`workflow.module.ts:220-223, 238-242`). This
  assumes one runtime configuration per Nest application. If multi-tenant or
  multi-database runtimes are a supported use case, provide a named/feature
  module factory with unique tokens instead of relying on global provider
  resolution.
- The optional controllers return full context, metadata, history, and command
  results. The documentation calls out the security responsibility correctly;
  consider response-mapper hooks or an explicit "admin controllers" module to
  make least-privilege deployment easier.

## Test and delivery observations

The following checks passed on the reviewed tree:

- `pnpm test` — 455 passed, 2 skipped
- `pnpm run test:coverage` — 455 passed, 2 skipped; 99.45% statements,
  98.11% branches, 100% functions, 99.70% lines
- `pnpm run lint`
- `pnpm run typecheck`
- `pnpm run build` (ESM and CJS)
- `pnpm run format:check`
- `git diff --check`
- `npm pack --dry-run` for all four packages (with a temporary npm cache)
- Direct ESM and CJS smoke import for `@duraflows/core`

The skipped tests are the `pg` and Kysely live PostgreSQL integration suites;
they require `DATABASE_URL`, which was not set in this environment. CI runs
them against PostgreSQL 16. That is good coverage for the normal path, but it
does not validate the stated PostgreSQL 13+ compatibility range or the
PostgreSQL 18 `uuidv7()` generation path. Add a version matrix, at least for
migration and locking compatibility, before treating that broad support claim
as continuously verified.

Recommended regression tests, in priority order:

1. Two independent `pg` providers and two independent Kysely providers must
   never share an ambient transaction.
2. `kyselyWorkflowProvidersFromTransaction()` must prefer its bound transaction
   over an unrelated ambient context (or explicitly reject the mismatch).
3. A throwing `onObserverError` handler must not reject a committed workflow
   operation or stop later observers.
4. A timeout followed by an `onEnter` failure must produce an explicit,
   observable final batch outcome.
5. `NaN`, infinity, invalid limit/offset, and invalid max-depth inputs must be
   rejected consistently at public API boundaries.

## Suggested remediation order

1. Fix and regression-test AR-01 before any multi-provider deployment.
2. Fix AR-02 and AR-03, then update their public contracts and operational
   metrics together.
3. Harden numeric validation (AR-04 and AR-05).
4. Update the timeout transaction documentation and add database-version
   compatibility coverage.
5. Decide whether an outbox/named-Nest-runtime design belongs in the next
   roadmap milestone based on production reliability and tenancy requirements.
