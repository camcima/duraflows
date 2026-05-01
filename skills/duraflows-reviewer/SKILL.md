---
name: duraflows-reviewer
description: "Code review checklist for duraflows workflow code. Use when reviewing pull requests, diffs, or code that defines WorkflowDefinition objects, implements WorkflowCommand handlers, configures WorkflowModule, or modifies workflow states, events, commands, or timeouts."
---

# duraflows Code Review Checklist

Use this checklist when reviewing code that touches duraflows workflows, commands, or configuration.

---

## Workflow Definition Review

### States

- [ ] **Terminal states are intentional.** Every state with no `events` is a dead end. Verify these are truly final states and not missing event definitions.
- [ ] **No orphan states.** Every state (except `initialState`) should be reachable as a `targetState` or `errorState` from at least one event or `onEnter`.
- [ ] **Context patches are correct.** State-defined `context` values merge on entry and **win** over command writes for the same key. Verify this is intentional (e.g., status resets).

### Events

- [ ] **Every event with mandatory commands that can fail has `errorState`** — OR the command is marked `bestEffort: true`. Without either, a `{ ok: false }` from a mandatory command throws `CommandFailureError` and the transaction rolls back. Verify the choice is intentional.
- [ ] **`targetState` is defined for state-changing events.** v1.0.0 made `targetState` optional to support command-only events (side effects without state change) and failure-only events. If an event has only `commands` (no `targetState`/`errorState`), confirm the side-effect-only intent.
- [ ] **`targetState === errorState` is allowed (v2.0.0).** When both branches point at the same state — typically the current state for poll/tick/retry shapes — the runtime collapses them into a single transition. Don't flag this as a duplicate-route mistake. Verify the intent ("stay here regardless of outcome, just record what happened") matches the event's `commands`.
- [ ] **At most one timeout event per state.** If a state has two events with `timeout`, the validator will reject the definition.
- [ ] **Timeout values are positive.** `afterMinutes`, `afterHours`, `afterDays` must all be > 0.
- [ ] **Per-command metadata is intentional.** A `WorkflowCommandRef` with `metadata: { ... }` makes that data visible to the handler via `ctx.commandMetadata`. Verify the handler actually reads it; verify metadata is JSON-serializable.

### Guards (v1.1.0)

- [ ] **A `guard` is the right tool — not an `errorState`.** Guards short-circuit before any command runs and return `outcome: "guard-rejected"`. `errorState` catches command failures only. If the rejection is normal business behavior (precondition not met), use a guard. If failure represents a fault to capture with full command results, use `errorState`. Flag any `errorState` that is really a precondition check, and any guard that is really catching a command failure.
- [ ] **Guard refs resolve to a registered guard.** When the convenience `guards: WorkflowGuard[]` option is used (or `knownGuardNames` is passed to the validator), unresolved refs fail at registration. With a custom `WorkflowGuardRegistry`, they surface only at first use as `WorkflowError`. Confirm every `eventDef.guard.name` is registered.
- [ ] **`eventDef.guard.name` matches the ref name in `rejectedBy` assertions.** The runtime reports the **declared ref name** in `WorkflowExecutionResult.rejectedBy` and the `rejected_by` history column — not the implementation's `.name` property. Flag any test asserting `rejectedBy` against a guard implementation's `.name` if the ref differs.
- [ ] **Guards are pure / read-only.** No DB writes, no external API calls, no `Math.random()`, no `Date.now()` (use `ctx.now`). The runtime hands the guard a `deepFreeze`d `ctx.context` clone — mutations throw under strict mode rather than leak. Push side effects into a command that runs after the guard passes.
- [ ] **Guards re-run on timeout sweeps.** A timeout-driven guard rejection clears `expiresAt` (so the next sweep won't re-pick that row) but the guard still ran. Anything non-idempotent inside the guard would repeat. Confirm the predicate is a pure function of `subject` + `ctx.context` + `ctx.commandMetadata`.
- [ ] **`guard.metadata` is intentional and consumed.** A `guard.metadata: { ... }` on the ref reaches the handler via `ctx.commandMetadata` (deep-frozen). Verify the implementation actually reads it; verify the metadata is JSON-serializable.
- [ ] **Bootstrap validation matches the registry shape.** `WorkflowModule.forRoot[Async]` accepts EITHER `guards: WorkflowGuard[]` (composed into an `InMemoryGuardRegistry`, validated at registration) OR `guardRegistry: WorkflowGuardRegistry` (custom; validation skipped). Passing both throws synchronously. Flag any module config that supplies both, or that references `WORKFLOW_GUARD_REGISTRY` while also passing `guards`.
- [ ] **Timeout poller observability accounts for `rejected`.** `ProcessExpiredWorkflowsResult` now has `rejected: number` (v1.1.0). If the poller logs only `processed`/`failed`, guard-rejected timeouts are silently invisible. Flag dashboards/alerts that don't surface `rejected`.

### onEnter Chains

- [ ] **No unintended depth.** Count the maximum chain length. Default `maxOnEnterDepth` is 10. Long chains run in a single transaction -- consider performance.
- [ ] **Error paths don't create cycles.** An `onEnter.errorState` that points back to a state with `onEnter.targetState` pointing forward can create subtle loops. The static cycle detector catches direct cycles, but indirect ones through error paths may not be caught.
- [ ] **onEnter without `targetState` is intentional.** Commands run as side effects, but the workflow stays in the current state. This is valid but uncommon.

---

## Command Implementation Review

### Determinism and Testability

- [ ] **Uses `ctx.now` instead of `Date.now()` or `new Date()`.** The injected clock enables deterministic testing. Every timestamp written to context should use `ctx.now`.
- [ ] **No `Math.random()` for business logic.** If randomness is needed, inject it or use an external service.

### Return Values

- [ ] **Returns `{ ok: false }` for business failures.** Payment declined, validation failed, inventory unavailable -- these are controlled failures, not exceptions.
- [ ] **Lets infrastructure errors throw.** Network errors, database failures -- don't catch-and-return-ok-false for these. Let them propagate so the transaction rolls back cleanly.
- [ ] **Includes `code` on both success and failure results.** Machine-readable codes make debugging easier (e.g., `"CHARGED"`, `"INSUFFICIENT_FUNDS"`).

### Context Usage

- [ ] **Context values are JSON-serializable.** No class instances, functions, `Date` objects (use ISO strings), `BigInt`, `undefined`, or circular references.
- [ ] **Context is not bloated.** Store IDs and references, not full payloads. Context is loaded on every operation.
- [ ] **No writes to `ctx.metadata`.** Metadata is `deepFreeze`d, so under strict mode (the default for ESM source files) any assignment throws `TypeError`; in a non-strict context it is silently dropped. Either way, if you see `ctx.metadata.x = y`, it's a bug — write through `ctx.context` instead.

### Idempotency

- [ ] **Commands that call external APIs use idempotency keys.** If a transaction rolls back and the event is re-triggered, the command runs again. Without idempotency, you get duplicate charges, duplicate notifications, etc.
- [ ] **Guard against double execution.** Common pattern: check if the result already exists in context before executing.
  ```ts
  if (ctx.context.chargeId) return { ok: true, code: "ALREADY_CHARGED" };
  ```

### Error Handling

- [ ] **Catch blocks don't swallow errors silently.** If you catch an error, either return `{ ok: false }` with meaningful `code`/`message`, or re-throw.
- [ ] **Non-critical side effects use `bestEffort: true` (v1.0.0)** — notifications, metrics, analytics, audit fan-out, compensation/rollback steps. The legacy "catch + return ok:true anyway" pattern lies in the audit trail; `bestEffort` records the failure honestly while still allowing the chain to continue. Flag any command that catches and returns `ok: true` instead of using `bestEffort`.
- [ ] **`bestEffort` is NOT used for business-critical work.** Payment capture, inventory adjustment, ledger writes must be mandatory commands routed to an `errorState`. Flag any `bestEffort` command whose failure could leave the system in an inconsistent state.

### Observers (v1.0.0)

- [ ] **No business-critical work in observers.** Observers fire post-commit, at-most-once, error-contained. Use a workflow command if the work must run inside the transaction or must retry on failure.
- [ ] **`onObserverError` is wired to a structured logger.** Defaulting to `console.warn` hides observer failures in production. NestJS `Logger`, Pino, Winston — anything that lands in your normal log stream.
- [ ] **Observer side effects are idempotent or tolerant of duplicates.** Although delivery is at-most-once per state entry within a process, a process crash between commit and observer fire silently drops the event. Treat observers as best-effort projections.
- [ ] **No long-running blocking work in `onEnter`.** Observers run sequentially; a slow observer delays subsequent observers and pushes back the runtime call's response time.

---

## Configuration Review

### NestJS Module

- [ ] **All command names referenced in definitions have implementations.** Either via `@WorkflowCommand("name")` decorator or explicit `commands` array. Missing implementations cause startup failure.
- [ ] **`enableControllers` is intentional.** REST endpoints expose workflow operations. Don't enable in production if you don't need them.
- [ ] **`forRootAsync` used when persistence depends on DI.** Don't create `Pool` instances in module decorators -- use factory pattern.
- [ ] **(v1.0.0) `forRootAsync` observers are inside `useFactory`'s return value, not at the top level.** The top-level `observers` field was removed from `WorkflowModuleAsyncOptions`. Move them into the `WorkflowModuleFactoryConfig` returned by `useFactory`. (The synchronous `forRoot` is unaffected.)
- [ ] **(v1.0.0) Observer providers are visible to the `forRootAsync` factory.** The factory can only inject providers that are global, declared in the module's `imports`, or exported by modules listed in `imports`. Bundling observers in their own module (`@Module({ providers: [Obs], exports: [Obs] })`) and adding it to `forRootAsync.imports` is the standard pattern. Flag any `forRootAsync` that injects an observer from `OrderModule.providers` directly — that won't work.
- [ ] **(v1.0.0) `forRootAsync<TArgs>` declares its factory args.** `forRootAsync<[Pool, AuditObserver]>({ ... })` typechecks `inject` against `useFactory` parameters. Without `<TArgs>`, factory params default to `unknown[]`.

### Timeout Processing

- [ ] **A poller is set up if any state has timeout events.** Without calling `processExpiredWorkflows()` periodically, timeouts never fire.
- [ ] **Polling interval is appropriate.** Sub-minute precision is meaningless (timeout resolution depends on poll frequency). `EVERY_MINUTE` is typical.
- [ ] **Limit is set.** Default is 100. For high-throughput systems, tune based on expected expiration volume.

### Database

- [ ] **Migration is applied.** `workflow_instances` and `workflow_history` tables must exist.
- [ ] **Indexes exist.** `expires_at` partial index is critical for timeout performance. `workflow_name` index for lookups. `workflow_instance_uuid, created_at DESC` for history queries.

---

## Common Mistakes to Flag

| Code Pattern                                                                                                           | Problem                                                                                                                              | Fix                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `ctx.context.timestamp = Date.now()`                                                                                   | Non-deterministic, breaks test reproducibility                                                                                       | `ctx.context.timestamp = ctx.now.toISOString()`                                                               |
| `ctx.context.data = new Map()`                                                                                         | Not JSON-serializable                                                                                                                | Use plain object `{}`                                                                                         |
| `ctx.metadata.status = "done"`                                                                                         | `ctx.metadata` is `deepFreeze`d — under strict mode the assignment throws `TypeError`; in non-strict contexts it is silently ignored | Write to `ctx.context.status` instead                                                                         |
| Mandatory event with commands but no `errorState`                                                                      | Command failure throws `CommandFailureError`                                                                                         | Add `errorState` OR mark non-critical command `bestEffort: true`                                              |
| `return { ok: true }` after network error catch                                                                        | Hides infrastructure failure                                                                                                         | If non-critical, mark `bestEffort: true` and return ok:false honestly. If critical, re-throw.                 |
| Compensation command catches and returns `{ ok: true }`                                                                | Lies in audit trail; loses error detail                                                                                              | (v1.0.0) Mark `bestEffort: true` and return the real `ok:false` — chain still continues                       |
| `Math.random() > 0.5 ? "a" : "b"` in command                                                                           | Non-deterministic behavior                                                                                                           | Use deterministic logic or external service                                                                   |
| State context and command writing same key without awareness                                                           | State context silently wins on merge                                                                                                 | Document or avoid key conflicts                                                                               |
| (v1.0.0) `WorkflowModule.forRootAsync({ observers: [...] })` at top level                                              | Field was removed; observers no longer wire up                                                                                       | Return `observers` from `useFactory` inside the factory config                                                |
| (v1.0.0) `forRootAsync` injects an observer that's only in the consuming module's `providers`                          | DI scope error at startup ("Nest can't resolve dependencies of WORKFLOW_MODULE_OPTIONS")                                             | Put the observer in its own module, export it, add the module to `forRootAsync.imports`                       |
| Business-critical work in a `WorkflowObserver.onEnter`                                                                 | Observer is post-commit + at-most-once + error-contained — failures are silently logged                                              | Move into a workflow command that runs inside the transaction                                                 |
| `WorkflowCommandRef.metadata` set but handler never reads `ctx.commandMetadata`                                        | Dead config — looks intentional, does nothing                                                                                        | Either consume in the handler or remove the metadata                                                          |
| (v1.1.0) Guard mutates `ctx.context` (e.g., `ctx.context.checkedAt = ctx.now.toISOString()`)                           | `ctx.context` is a `deepFreeze`d clone; mutation throws under strict mode and never persists                                         | Move the write into a command that runs after the guard passes                                                |
| (v1.1.0) Guard calls an external service or DB                                                                         | Repeats on every timeout sweep; non-idempotent I/O leaks                                                                             | Compute the predicate from `subject` + `ctx.context` only, or precompute the value into context via a command |
| (v1.1.0) `errorState` used to catch a precondition that should be a `guard`                                            | `errorState` runs commands first and records a "failure"; guard rejection is short-circuit + business-meaningful                     | Replace with `guard: { name: "..." }`; remove the routing `errorState` if it had no other purpose             |
| (v1.1.0) Test asserts `rejectedBy === guard.name` (implementation name)                                                | The runtime reports the declared `eventDef.guard.name` (ref name); aliasing registries diverge                                       | Assert against the **ref name** from the workflow definition                                                  |
| (v1.1.0) `WorkflowModule.forRoot({ guards: [...], guardRegistry: ... })` — both passed                                 | Mutually exclusive; the module throws synchronously                                                                                  | Pick one: array form for the convenience path, prebuilt registry for DI/lazy loading                          |
| (v1.1.0) Poller logs only `processed`/`failed`, never `rejected`                                                       | Guard-rejected timeouts disappear from observability                                                                                 | Surface `result.rejected` in logs/metrics/dashboards alongside `processed`                                    |
| (v1.1.0) Workflow definition references `guard.name` not in any registered guard, with no `knownGuardNames` validation | Fails at first use as `WorkflowError`, not at startup                                                                                | Pass `knownGuardNames` to the validator OR rely on `guards: [...]` (which auto-checks)                        |
| (v1.1.0) Custom adapter persists `rejected_by` on append but maps it as `null` on read                                 | `WorkflowHistoryRecord.rejectedBy` should be `undefined` when absent, not `null`                                                     | Map `null → undefined` in the read path; same convention as `errorMessage`                                    |

---

## PR Description Checklist

When reviewing a PR that modifies workflows, ensure the description covers:

- [ ] Which workflow definition(s) changed
- [ ] New states, events, or commands added
- [ ] Error handling strategy (what has `errorState`, what throws)
- [ ] Timeout behavior (if any)
- [ ] Idempotency considerations for new commands
- [ ] Migration required (new states for in-flight instances?)
