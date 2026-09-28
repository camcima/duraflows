---
name: duraflows-developer
description: "Provides domain expertise for developing durable workflows with @duraflows/core, @duraflows/pg, @duraflows/kysely, and @duraflows/nestjs. Use when writing, reviewing, or debugging code that imports duraflows packages, defines WorkflowDefinition objects, implements WorkflowCommand handlers, configures WorkflowModule, or works with workflow states, events, commands, timeouts, or onEnter chains."
---

# duraflows Developer Guide

## Architecture

duraflows is a **durable workflow runtime** for TypeScript built on [@camcima/finita](https://github.com/camcima/finita) (FSM engine). Four packages:

| Package             | Purpose                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `@duraflows/core`   | Framework-agnostic runtime, types, persistence interfaces                                 |
| `@duraflows/pg`     | PostgreSQL adapter using `pg` (SKIP LOCKED, JSONB, row-level locking)                     |
| `@duraflows/kysely` | PostgreSQL adapter using Kysely (idiomatic query builder, AsyncLocalStorage transactions) |
| `@duraflows/nestjs` | NestJS module with DI, services, optional REST controllers                                |

**Compatibility:** duraflows v2.0.0+ declares `engines.node >= 20` (carried through from `@camcima/finita` v3). The pre-v2 line predates the Node 20 floor and shipped without an `engines` field — check the published package's `engines.node` for exact runtime requirements. The public WorkflowDefinition surface is unchanged across the v1 → v2 boundary; the v2 bump is an internal Finita upgrade plus the Node floor.

**Important**: duraflows is NOT like Temporal. Commands are intentionally side-effecting -- they call APIs, write to databases, send messages. There is no replay or checkpointing. Durability comes from:

- Persisted workflow state (current state, context, version)
- Complete immutable audit history of every transition
- Transactional updates with row-level locking
- Timeout handling via persisted deadlines

---

## Core Concepts

### WorkflowDefinition

A plain TypeScript object describing the state machine:

```ts
import type { WorkflowDefinition } from "@duraflows/core";

const workflow: WorkflowDefinition = {
  name: "order", // unique identifier
  version: 1, // (v5.0.0) optional, defaults to 1 — see Definition Versions below
  versionPolicy: "pinned", // (v7.0.0) optional, defaults to "pinned" — see Definition Versions below
  initialState: "new", // must exist in states
  states: {
    new: {/* WorkflowStateDefinition */},
    processing: {/* ... */},
    completed: {}, // terminal state (no events)
  },
};
```

### Definition Versions (v5.0.0)

Every `WorkflowDefinition` carries an explicit `version` -- a positive safe integer, defaulting to `1` when omitted. Bump it whenever the definition's **content** changes. The canonical content hash used to detect drift deliberately **excludes** `version` itself: relabeling a version without changing anything else never trips the guard, but changing content without bumping the version does.

At startup -- or lazily, on the first `createInstance`/`triggerEvent`/`processExpiredWorkflows`/`rearmTimeout` call if `initialize()` was never invoked -- `WorkflowRuntime.initialize()` snapshots every registered definition into the `workflow_definitions` table (via the optional `definitionStore`) and compares content hashes against what's already stored. If a previously-registered `(workflowName, version)` now has different content, it throws `WorkflowDefinitionError` instead of silently running drifted logic. `initialize()` is idempotent: concurrent and repeated calls share one sync, and a failed sync is not cached, so the next call retries.

Instances and history rows record the version that governed them: `WorkflowInstance.definitionVersion` (**required**, `number | null`) and `WorkflowHistoryRecord.definitionVersion` (**optional**, `number | null | undefined` -- set per `append()` call, mapped `NULL` -> `undefined` on read). Both are stamped at creation and re-stamped on every transition. `null` marks a legacy row that predates versioning; it picks up a real version stamp on its next transition.

**(v7.0.0) Pinned by default.** Each instance now executes the version it's stamped with, not whatever is currently registered -- older versions load from the stored snapshot in `workflow_definitions`. New instances always start on the latest registered version. Instances created before versioning existed (`definitionVersion: null`) are the exception: they resolve the latest definition and get stamped with it on their next transition. Requires a `definitionStore`; without one, pinning is inert (every instance executes the latest, with a one-time `console.warn` while any registered definition is pinned).

Opt out with `versionPolicy: "latest"` to keep pre-7.0.0 behavior for a workflow: every instance executes the currently registered definition. **The latest registered definition's `versionPolicy` governs every instance of that workflow** -- it's not a per-instance setting. If an instance's current state doesn't exist in the latest definition, it throws `IncompatibleDefinitionError` instead of silently running on a definition that can't describe it (an event that no longer exists on a state the definition still has keeps surfacing as `InvalidEventError`). `versionPolicy` is excluded from the content hash, so flipping it never needs a version bump.

**Deploying a change safely:** bump `version`; keep the commands/guards the old version references registered until every instance stamped with it has drained -- `initialize()`'s startup executability check (`onUnresolvable: "fail"`, the default) fails startup if you delete them too early. Use `runtime.listDefinitionVersions(name)` to check `activeInstances === 0` before retiring them:

```ts
const versions = await runtime.listDefinitionVersions("order");
// [{ version: 1, activeInstances: 0, ... }, { version: 2, activeInstances: 42, ... }]
```

**(v7.0.0) Event names starting with `"$"` are reserved** and rejected by validation (`Event names starting with "$" are reserved`) -- don't use them for your own events; they're set aside for system-generated events, such as (v7.1.0) `migrateInstances`'s `$migrated`.

**Limitation:** a persisted `expiresAt` deadline is recomputed only when a state is next entered -- changing a state's timeout duration in a new version does not move deadlines already waiting in that state for instances still on an older version.

### Migrating instances (v7.1.0)

`runtime.migrateInstances(input)` (and `WorkflowService.migrateInstances(input)` in NestJS -- no HTTP endpoint) moves chosen instances from one stored version to another. `versionPolicy: "latest"` already gets a fix to every in-flight instance on its very next transition; reach for `migrateInstances` when that's not enough -- the change renames/removes a state (`"latest"` throws `IncompatibleDefinitionError` for an instance sitting in one instead), needs to reshape context, only some instances should move, or an old version can't retire because its instances won't finish on their own and draining isn't an option. It is **pure relabeling**: no commands, guards or `onEnter` run.

**(v7.2.0) Three behavior changes reach every caller**, even one that passes none of the new inputs below: a `transformContext` returning something other than a plain object now fails that instance with `transformContext must return a plain object`; a `findInstanceUuids` page that isn't strictly ascending past the cursor, or that contains a non-string entry, now interrupts the call (`MigrationInterruptedError`, below) instead of being trusted, and an over-long page is truncated to the requested size; and a `findInstanceUuids` rejection now arrives wrapped as `MigrationInterruptedError`, `cause` set to the original error -- so an `instanceof <YourStoreError>` check must test `error.cause`, not `error`.

```ts
const preview = await runtime.migrateInstances({
  workflowName: "order",
  fromVersion: 3,
  toVersion: 4,
  stateMapping: { awaiting_review: "awaiting_approval" }, // renamed/removed states only
  dryRun: true, // always try this first
});

// Migrate in batches; the cursor means no instance is ever examined twice.
let cursor: string | undefined;
do {
  const batch = await runtime.migrateInstances({
    workflowName: "order",
    fromVersion: 3,
    toVersion: 4,
    stateMapping: { awaiting_review: "awaiting_approval" },
    excludeStates: ["completed", "cancelled"], // leave finished instances alone
    limit: 500,
    cursor,
  });
  cursor = batch.nextCursor ?? undefined;
} while (cursor);
```

With a `cursor`, the loop is complete: `nextCursor` becomes the next call's `cursor`, so every candidate is examined exactly once and a skip/failure never makes the loop stop early. Without a `cursor` -- the 7.1 caveat, now scoped to cursor-less calls -- a call migrating nothing doesn't mean `fromVersion` has drained: check that call's `skipped`/`failed` and `runtime.listDefinitionVersions(name)`, since a skip/failure stays on `fromVersion` and is re-examined, from the lowest UUID, by every later call, so enough of them can starve migratable instances sitting further along in UUID order. Fix likely skips first (the dry run lists them), or drop `limit` -- one call without it pages through everything internally and never revisits an instance, at the cost of holding the whole result (every migrated/skipped/failed entry) in memory for that call's whole run. Also: a worker still running code whose in-code registered `version` is `fromVersion` keeps handing the migration fresh candidates via `createInstance()`, so upgrade every worker to `toVersion` before expecting the count to reach zero.

Per instance: `states`/`excludeStates`, if given, are checked against the current state and a non-matching instance is skipped (`state <s> is excluded by the state filter`); `stateMapping` (or a same-named state in `toVersion`) picks the target state; `transformContext(context, instance)`, if given, must be pure and return a plain object -- a `Date`, `Map`, array or class instance fails the instance instead -- and its result is stored as its JSON round trip (a `Date` comes back a string); `expiresAt` is recomputed from `lastTransitionAt` (elapsed time preserved, not reset); `timeoutRetry` is cleared; `lastTransitionAt` itself is unchanged (migration is not a transition); a `$migrated` history row is written (`triggerMetadata: { source: "migration", fromVersion, toVersion }`) and observers fire with `triggerEvent: "$migrated"` after commit, even when the state name didn't change.

**Observers see migrations too.** `$migrated` fires through the same post-commit path as any other transition, so an observer with side effects should ignore it:

```ts
onEnter: async (event) => {
  if (event.triggerEvent === "$migrated") return;
  await sendCustomerEmail(event);
},
```

Candidates are every instance stamped with `fromVersion`, finished ones included, unless `excludeStates` leaves them out (or `instanceUuids` scopes down to specific ones) -- a migration run without either therefore relabels completed instances too, appending a `$migrated` history row and firing observers for them.

**Mapping into a state with an `onEnter` never runs it.** A `stateMapping` target with an `onEnter` in `toVersion` throws `InvalidArgumentError` up front, before any instance is touched; an instance that would keep its current name into a state that has since grown an `onEnter` is skipped instead, not migrated. Skip reasons (`result.skipped[].reason`, verbatim): `not found`, `belongs to workflow <name>`, `unstamped`, `on version <v>, not <fromVersion>`, `state <s> is excluded by the state filter` (v7.2.0), `state <s> has no mapping and does not exist in version <toVersion>`, `state <s> has an onEnter in version <toVersion>`. A throwing or invalid `transformContext`, or an optimistic-lock conflict, lands that one instance in `failed` and the batch continues -- distinct from a failure _listing_ candidates, which stops the whole call (see `MigrationInterruptedError` below).

`limit` caps candidates _examined_ per call (skipped/failed count too, not just migrated), and its cursor holds only within that call: a migrated instance leaves `fromVersion` for good, but a skipped or failed one stays on it and is re-examined by the next call, from the lowest UUID without `cursor` or from `cursor` with it. Without `instanceUuids`, candidates come from the optional `WorkflowInstanceStore.findInstanceUuids`, called with `states`/`excludeStates` as hints (honoring them is optional -- `migrateInstances` re-checks the filter itself either way) and paged 100 at a time, truncated to the requested size even if the store returns more -- an adapter without `findInstanceUuids` requires `instanceUuids` to be passed explicitly. `result.nextCursor` is the last UUID examined (`null` once every candidate has been examined, or when `instanceUuids` was given); `result.warnings` lists non-fatal problems, such as `toVersion` referencing commands/guards this process hasn't registered.

**`MigrationInterruptedError`** (v7.2.0) is thrown instead of returning when _listing_ candidates itself fails -- `findInstanceUuids` rejected, or returned a page that isn't strictly ascending past the cursor or that contains a non-UUID entry. It's never thrown for a per-instance problem (those land in `failed`). `error.result` is the partial result, with `nextCursor` set to the last UUID examined (or the input `cursor`, or `null`, if none was); `error.cause` is the original error, so test `error.cause instanceof <YourStoreError>`, not `error instanceof`. Resume with `{ ...input, cursor: error.result.nextCursor ?? undefined }`.

**Rescue cases.** Migration reads only the instance's current state and the target version, never the old version's snapshot, so it rescues instances a pinned read can't reach: a missing/invalid stored snapshot for `fromVersion`, an `IncompatibleDefinitionError` under `versionPolicy: "latest"`, and parked instances (their `timeoutRetry` is cleared). It syncs definitions but **skips the startup executability check** -- a failing check is often exactly what a migration is fixing.

**When the check blocks boot entirely.** That skip only helps once `migrateInstances` itself runs -- NestJS's `WorkflowRuntimeInitializer.onModuleInit` (and any app calling `await runtime.initialize()` at boot) awaits the _full_ `initialize()`, check included, so `onUnresolvable: "fail"` (the default) still stops the app from booting and `migrateInstances` is never reached through it. Either run the migration from a one-off script that builds its own `WorkflowRuntime` against the same persistence, definitions and **observers** as the app and calls `migrateInstances` without calling `initialize()` first -- passing the app's own observers means audit and projection observers still see the `$migrated` events -- or deploy temporarily with `onUnresolvable: "warn"`, migrate, then restore `"fail"`.

See [Migrating instances](../../docs/workflow-definitions.md#migrating-instances) and [`migrateInstances()`](../../docs/core-runtime.md#migrateinstances) for the full validation table and semantics.

### States

Each state can have:

- **`context`**: Values merged into workflow context when entering this state (state context wins over command writes for same keys)
- **`events`**: Map of available events from this state. A state with no events is **terminal**
- **`onEnter`**: Auto-fire behavior when entering (gateway pattern). See [onEnter Chains](#onenter-chains)
- **`metadata`**: Arbitrary state metadata

### Events

Events trigger state transitions. Each event can have:

- **`targetState`** (optional, v1.0.0): State to transition to on success. Omit for command-only events that run side effects without changing state.
- **`errorState`** (optional): State to transition to on command failure
- **`commands`**: Ordered list of `{ name: string, metadata? }` command references, executed sequentially (fail-fast for mandatory commands; bestEffort commands continue on failure)
- **`guard`** (optional, v1.1.0): `{ name: string, metadata? }` reference to a registered `WorkflowGuard`. Evaluated **before** any commands. If it returns `false`, the event short-circuits with `outcome: "guard-rejected"`, no commands run, no state change. See [Guards](#guards-v110)
- **`timeout`**: Auto-trigger after duration. Fields `afterMinutes`, `afterHours`, `afterDays` are **additive**
- **`metadata`**: Arbitrary event metadata

**v1.0.0:** an event must define **at least one** of `targetState`, `errorState`, or `commands`. Three valid shapes:

| Shape               | Has `targetState`? | Has `errorState`? | Has `commands`? | Use case                                                                                             |
| ------------------- | ------------------ | ----------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Standard transition | ✓                  | optional          | optional        | Most events                                                                                          |
| Command-only event  | ✗                  | ✗                 | ✓               | Side-effect actions (notes, manual corrections, side-effect kicks) — workflow stays in current state |
| Failure-only event  | ✗                  | ✓                 | ✓               | Trap a failure, route to recovery without forward progress                                           |

**Outcome rules** (mandatory commands; see [bestEffort](#besteffort-commands) for the relaxed semantics):

| Scenario                                                             | Result                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Guard returns `false` (v1.1.0)                                       | `guard-rejected`, stays in current state, no commands run, history row appended with `rejectedBy` |
| Guard throws (v1.1.0)                                                | Exception propagates, transaction rolls back (treat as infrastructure error)                      |
| No commands                                                          | `success` -> `targetState` (or stays if no `targetState`)                                         |
| All commands return `{ ok: true }`                                   | `success` -> `targetState` (or stays)                                                             |
| Any mandatory command returns `{ ok: false }` + `errorState` defined | `failure` -> `errorState`                                                                         |
| Any mandatory command returns `{ ok: false }` + no `errorState`      | Throws `CommandFailureError`, no transition                                                       |
| Any mandatory command throws                                         | Exception propagates, transaction rolls back                                                      |

**v1.1.0:** `errorState` catches **command** failures only — it does not catch guard rejections. Guard rejection means "this event is not allowed right now," which is a meaningful business signal (let the caller retry later or pick a different event) — not a fault to recover from.

**v2.0.0:** when an event's `targetState` and `errorState` point at the **same** state (e.g., a polling shape `poll: { targetState: "active", errorState: "active", commands: [...] }`), the compiler collapses the two branches into a single transition at compile time (Finita v3's `ProcessBuilder` rejects two transitions with identical `(from, event, to)` and conflicting conditions). Both outcomes still resolve correctly and the result still distinguishes `outcome: "success"` vs `"failure"` — so history still records what actually happened. This is the right shape for "stay in this state regardless of outcome, but record the result" patterns.

### Guards (v1.1.0)

Per-event preconditions. A guard is a **read-only** predicate that decides whether an event is allowed to fire **before** any commands run. Use guards for:

- "Is the user verified?" → block events that require KYC
- "Is the cart total ≥ minimum?" → block submission below threshold
- "Is the deadline reached?" + a timeout → only auto-progress past business hours

```ts
import type { WorkflowGuard, WorkflowExecutionContext } from "@duraflows/core";

class IsVerifiedGuard implements WorkflowGuard<Customer> {
  readonly name = "isVerified";
  evaluate(subject: Customer, ctx: WorkflowExecutionContext): boolean {
    return subject.verified === true;
  }
}
```

Then reference it from a workflow event:

```ts
events: {
  Submit: {
    guard: { name: "isVerified" },          // ref name resolved against the guard registry
    targetState: "submitted",
    commands: [{ name: "createOrder" }],
  },
}
```

**Semantics:**

- **Pure / read-only.** The runtime hands the guard a `deepFreeze`d clone of `ctx.context`. Mutations throw under strict mode rather than silently leaking into persisted state. Side effects (DB writes, external calls) belong in commands, which run **after** the guard passes.
- **Inside the same transaction.** Guard evaluation, the rejection-or-pass decision, and the resulting history append all run inside the per-event transaction.
- **Re-evaluable.** A timeout sweep retries an instance the next tick if the deadline isn't cleared. Anything non-idempotent inside a guard would repeat without compensation.
- **Not catchable by `errorState`.** A guard rejection is meaningful business state ("event not allowed right now"), not a fault.
- **Timeout interaction.** When a guard rejects a timeout-driven event, the runtime additionally clears `expiresAt` so the sweep won't re-pick the instance. The rejection counts toward `ProcessExpiredWorkflowsResult.rejected`, not `processed`.

**Per-event metadata.** A `guard.metadata` object reaches the implementation through `ctx.commandMetadata` (deep-cloned + frozen for the evaluation), the same channel commands use. This lets one guard implementation serve many events with different parameters:

```ts
// In the workflow:
events: {
  ApplyDiscount: { guard: { name: "minTier", metadata: { minTier: "gold" } }, /* ... */ },
  Refund:        { guard: { name: "minTier", metadata: { minTier: "silver" } }, /* ... */ },
}

// In the guard:
const minTier = ctx.commandMetadata.minTier as Tier;
return tierAtLeast(subject.tier, minTier);
```

**Ref names vs implementation names.** The runtime resolves the registry by `eventDef.guard.name` and reports that ref name in `WorkflowExecutionResult.rejectedBy`. With aliasing custom registries, the ref name and the registered guard's `.name` property can diverge — definitions are the source of truth. Tests asserting on `rejectedBy` should match the **ref name**.

**Registries.** A built-in `InMemoryGuardRegistry` is provided. The NestJS module composes a registry from a `guards: WorkflowGuard[]` option, or accepts a prebuilt `guardRegistry: WorkflowGuardRegistry` for DI-backed or lazy-loading registries. The two options are mutually exclusive — passing both throws synchronously. When a custom registry is used, the validator can't enumerate names, so `eventDef.guard.name` refs are checked **at first use** and surface as `WorkflowError("Guard \"<name>\" not found in registry")` rather than at startup.

**Guard vs `errorState`.** The choice is semantic, not just structural:

| Use a guard when                                            | Use `errorState` when                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| The decision is read-only ("is this allowed?")              | A command can fail and the workflow should branch to recovery    |
| Rejection is normal business behavior                       | Failure represents a fault to capture and handle                 |
| The caller may simply try again later or pick another event | The caller is committed and the workflow needs an alternate path |
| You want to short-circuit before any side effect runs       | You want command outcomes recorded with full context             |

Note: `getAvailableEvents` lists events by state shape — it does **not** evaluate guards. UI code that wants to hide events whose guard would reject must call the guard itself or expose a separate predicate; the runtime won't filter the list for you.

### Commands

Commands implement the `WorkflowCommand` interface and execute side effects:

```ts
import type { WorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/core";

class ChargePaymentCommand implements WorkflowCommand<Order> {
  async execute(subject: Order, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const customerId = ctx.metadata.customerId as string; // read immutable metadata

    try {
      const charge = await this.gateway.charge(subject.total, customerId);
      ctx.context.chargeId = charge.id; // write mutable context
      ctx.context.chargedAt = ctx.now.toISOString(); // use ctx.now, NOT Date.now()
      return { ok: true, code: "CHARGED" };
    } catch (err) {
      return { ok: false, code: "PAYMENT_FAILED", message: String(err) };
    }
  }
}
```

**CommandResult fields:** `ok` (boolean), `code?` (machine-readable), `message?` (human-readable), `metadata?` (additional data), `error?` (error details)

### Context vs Metadata

|                             | Context                            | Metadata                            |
| --------------------------- | ---------------------------------- | ----------------------------------- |
| **Purpose**                 | Mutable working memory             | Immutable identity labels           |
| **Set at creation**         | Yes                                | Yes                                 |
| **Modified by transitions** | Yes (state context merged)         | No                                  |
| **Writable by commands**    | Yes (`ctx.context.x = y`)          | No (frozen object)                  |
| **Typical contents**        | `retryCount`, `chargeId`, `status` | `orderId`, `customerId`, `tenantId` |

**Context has three sources:**

1. Seeded at creation via `createInstance({ context: { ... } })`
2. Merged from state definition when entering a state
3. Written by commands via `ctx.context`

### WorkflowExecutionContext

Passed to every command:

```ts
interface WorkflowExecutionContext {
  triggerMetadata: Readonly<Record<string, unknown>>; // who/what triggered (frozen)
  now: Date; // from injected clock
  context: Record<string, unknown>; // MUTABLE working memory
  metadata: Readonly<Record<string, unknown>>; // immutable identity (frozen)
  readonly commandMetadata: Readonly<Record<string, unknown>>; // v1.0.0: per-command metadata from WorkflowCommandRef.metadata
  readonly fromState: string | null; // v1.0.0: state being left (null on initial create)
  readonly toState: string; // v1.0.0: state being entered for this command
  readonly transitionUuid: string; // v1.0.0: shared with the matching observer event
}
```

**v1.0.0 transition fields** are useful for:

- **Structured logging** without re-querying the instance
- **Distributed tracing** — `transitionUuid` correlates command logs with the post-commit observer event for the same state entry
- **Branching on origin** — `if (ctx.fromState === "retry_pending") { ... }`

**`commandMetadata` (v1.0.0)** lets one handler serve many call sites with different parameters:

```ts
// In the workflow definition:
commands: [
  { name: "send-notification", metadata: { channel: "email", template: "payment-confirmed" } },
  { name: "send-notification", metadata: { channel: "sms", template: "delivered" } },
];

// In the handler:
const channel = ctx.commandMetadata.channel as string;
const template = ctx.commandMetadata.template as string;
```

Each command in a chain sees its own metadata (deep-cloned + frozen) — never a sibling's.

### onEnter Chains

States can auto-transition when entered (gateway pattern):

```ts
states: {
  validating: {
    onEnter: {
      targetState: "validated",
      errorState: "validation_failed",
      commands: [{ name: "runValidation" }],
    },
  },
}
```

- Commands succeed + `targetState` -> transitions to `targetState`
- Commands succeed + no `targetState` -> stays (commands ran as side effects)
- Commands fail + `errorState` -> transitions to `errorState`
- Commands fail + no `errorState` -> throws `CommandFailureError`, rollback
- Chains: if `targetState` also has `onEnter`, the chain continues. All hops run in one transaction
- Depth guard: default 10 (configurable via `maxOnEnterDepth`). Static cycle detection at registration

### bestEffort Commands

Commands can opt out of fail-fast semantics by setting `bestEffort = true` (v1.0.0):

```ts
class SendNotificationCommand implements WorkflowCommand {
  readonly bestEffort = true;

  async execute(subject, ctx): Promise<CommandResult> {
    try {
      await this.mailer.send(/* ... */);
      return { ok: true, code: "NOTIFICATION_SENT" };
    } catch (err) {
      return { ok: false, code: "MAIL_DOWN", message: String(err) };
    }
  }
}
```

| Outcome                 | Mandatory command                                                   | `bestEffort: true`                                                                                              |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Returns `{ ok: true }`  | Chain continues                                                     | Chain continues                                                                                                 |
| Returns `{ ok: false }` | Chain stops; routes to `errorState` or throws `CommandFailureError` | Result recorded; chain continues; aggregate `outcome` stays `success`                                           |
| Throws                  | Exception propagates; transaction rolls back                        | Caught and recorded as `{ ok: false, code: "BEST_EFFORT_THROWN", error: { name, message, stack? } }`; continues |

**Use bestEffort for:**

- Notifications (email, SMS, webhooks) where a flaky provider should not block business state
- Metrics, analytics pings, audit fan-out
- Cache invalidation
- Compensation commands (undoing prior reservations) — replaces the v0.x pattern of catching errors and returning `{ ok: true }` manually

**Don't use bestEffort for** anything whose failure should affect business state — payment capture, inventory adjustment, ledger writes. Use mandatory commands routed to an `errorState` instead.

### Observers

Observers are post-commit lifecycle hooks (v1.0.0). The runtime fires a `StateEnterEvent` on every state entry — events, onEnter hops, timeouts, and the initial `createInstance` entry — **after** the transaction commits.

```ts
import type { WorkflowObserver, StateEnterEvent } from "@duraflows/core";

const auditObserver: WorkflowObserver = {
  name: "audit",
  onEnter: async (event: StateEnterEvent) => {
    await auditLog.record({
      workflow: event.workflowName,
      instance: event.instanceUuid,
      state: event.toState,
      transitionUuid: event.transitionUuid,
      at: event.occurredAt,
    });
  },
};
```

**Semantics:**

- **Post-commit** — the database write is durable before observers run. An observer never sees a state that was rolled back.
- **At-most-once** — an observer that throws is not retried.
- **Sequential** — observers run in registration order.
- **Error-contained** — a thrown error is routed to `onObserverError` (default `console.warn`). It does not roll back, propagate, or affect other observers.
- **Self-transitions count** — command-only events fire observers with `fromState === toState`. Filter on that if you want to distinguish.
- **Snapshot** — `event.context`/`metadata`/`triggerMetadata` are deep-cloned + deep-frozen. Safe to retain indefinitely.

**Correlation:** `event.transitionUuid` matches the `transitionUuid` on the `WorkflowExecutionContext` seen by commands that ran on entry to the same state. Use it to correlate command logs with observer events.

**Right place for:** audit trails, metrics, projections, cache invalidation, webhooks. Post-commit + at-most-once means **don't put business-critical work here** — use a workflow command if the work must run inside the transaction or must retry on failure.

### Timeouts

```ts
events: {
  AutoClose: {
    targetState: "closed",
    timeout: { afterDays: 14 },           // additive: afterMinutes + afterHours + afterDays
  },
}
```

- At most **one timeout event per state**
- Requires an external poller calling `processExpiredWorkflows()` (cron, NestJS `@Cron`)
- Uses `FOR UPDATE SKIP LOCKED` in PostgreSQL so concurrent sweeps don't block each other; each instance is then re-locked with `lockByUuid` and re-checked before it's processed
- Timeout events fire with `triggerMetadata: { source: "timeout" }`
- **(v6.0.0)** A failing timeout is retried with exponential backoff and **parked** after `timeoutRetry.maxAttempts` consecutive failures -- see [Timeout Processing](#timeout-processing)

---

## Deterministic Guardrails

### Prohibited in Commands

| Do NOT use                         | Use instead                                                                     | Why                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Date.now()` / `new Date()`        | `ctx.now`                                                                       | Enables testable, reproducible timestamps via injectable clock |
| `Math.random()` for business logic | Deterministic logic or external service                                         | Makes testing non-deterministic                                |
| Non-serializable values in context | JSON-compatible values only (strings, numbers, booleans, arrays, plain objects) | Context is persisted as JSONB                                  |
| Large payloads in context          | Store IDs, fetch full data in commands                                          | Context is loaded on every operation                           |

### Required Practices

- **Always define `errorState`** on events with commands that can fail. Without it, `CommandFailureError` is thrown and no state transition occurs.
- **Make commands idempotent** where possible. If a transaction rolls back due to infrastructure failure, the same event may be triggered again. Use idempotency keys or check-before-write patterns.
- **Return `{ ok: false }`** for business failures (payment declined, validation failed). Let infrastructure errors (network, DB) throw naturally -- they cause transaction rollback with no state change.
- **Use `ctx.now.toISOString()`** for timestamps in context, not `Date.now()`.

---

## Context Merge Order

During a transition:

1. Commands execute and may mutate `ctx.context`
2. Workflow transitions to the new state
3. New state's `context` values are merged **on top** (state context wins for same keys)

This means state-defined context acts as "reset" values. If a command writes `paymentStatus = "processing"` and the target state defines `paymentStatus: "confirmed"`, the final value is `"confirmed"`.

---

## Setup Patterns

### NestJS (synchronous)

```ts
import { WorkflowModule } from "@duraflows/nestjs";
import { pgWorkflowProviders } from "@duraflows/pg";

WorkflowModule.forRoot({
  workflows: [orderWorkflow],
  commands: [{ name: "chargePayment", useClass: ChargePaymentCommand }],
  guards: [new IsVerifiedGuard()], // v1.1.0: built-in guards composed into an InMemoryGuardRegistry
  persistence: pgWorkflowProviders(pool),
  enableControllers: true, // optional REST endpoints
});
```

### NestJS (async, v1.0.0)

`forRootAsync` is generic over the factory's argument tuple. Declaring `<TArgs>` typechecks `inject` against `useFactory` parameters at compile time. Observers, `onObserverError`, `clock`, and `timeoutRetry` go in the factory's return value (the `WorkflowModuleFactoryConfig`) so they can compose from injected services.

```ts
WorkflowModule.forRootAsync<[ConfigService, AuditService]>({
  imports: [ConfigModule, AuditModule],
  commands: [{ name: "chargePayment", useClass: ChargePaymentCommand }],
  useFactory: (config, audit) => ({
    workflows: [orderWorkflow],
    persistence: pgWorkflowProviders(new Pool({ connectionString: config.get("DATABASE_URL") })),
    observers: [{ name: "audit", onEnter: (e) => audit.record(e) }],
    guards: [new IsVerifiedGuard()], // v1.1.0; or pass a prebuilt guardRegistry instead (mutually exclusive)
    onObserverError: (error, observer, event) => {
      logger.warn(`Observer "${observer.name}" failed for ${event.instanceUuid}: ${String(error)}`);
    },
  }),
  inject: [ConfigService, AuditService],
});
```

**v1.0.0 BREAKING:** `WorkflowModuleAsyncOptions.observers` was removed from the top level. Move existing `observers: [...]` into the object returned by `useFactory`. The synchronous `forRoot` is unchanged — `observers` remains a top-level option there.

**Provider DI scope gotcha:** the `forRootAsync` factory can only inject providers that are global, declared in this module's `imports`, or exported by modules listed there. This applies to anything passed through `inject` — observers and guards included. If your observer or guard is a NestJS provider in the consuming module, bundle it in its own module:

```ts
@Module({ providers: [OrderAuditObserver], exports: [OrderAuditObserver] })
class OrderObserversModule {} // same fix applies to a DI-backed guard

WorkflowModule.forRootAsync<[pg.Pool, OrderAuditObserver]>({
  imports: [OrderObserversModule],
  useFactory: (pool, audit) => ({
    workflows: [orderWorkflow],
    persistence: pgWorkflowProviders(pool),
    observers: [audit],
  }),
  inject: [PG_POOL, OrderAuditObserver],
});
```

### NestJS @WorkflowCommand Decorator

```ts
import { WorkflowCommand } from "@duraflows/nestjs";

@WorkflowCommand("chargePayment") // auto-discovered, no need for explicit commands array
export class ChargePaymentCommand implements WorkflowCommandInterface {
  constructor(private readonly gateway: PaymentGateway) {} // NestJS DI
  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    /* ... */
  }
}
```

### Standalone (no framework)

```ts
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  InMemoryGuardRegistry, // v1.1.0
} from "@duraflows/core";
import { pgWorkflowProviders } from "@duraflows/pg";

const persistence = pgWorkflowProviders(pool);
const definitionRegistry = new InMemoryDefinitionRegistry();
definitionRegistry.register(orderWorkflow);

const commandRegistry = new InMemoryCommandRegistry();
commandRegistry.register("chargePayment", new ChargePaymentCommand(gateway));

// v1.1.0: only required if any definition uses an event guard
const guardRegistry = new InMemoryGuardRegistry();
guardRegistry.register("isVerified", new IsVerifiedGuard());

const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  guardRegistry, // omit if no events declare a guard
  ...persistence, // includes definitionStore -- pgWorkflowProviders() always supplies it
  clock: { now: () => new Date() },
});

// (v5.0.0) Recommended: call explicitly at boot so a version-bump violation
// (WorkflowDefinitionError) surfaces before the app starts serving traffic,
// instead of lazily on the first createInstance/triggerEvent/processExpiredWorkflows call.
await runtime.initialize();
```

In NestJS, `WorkflowModule` does this automatically -- it registers a `WorkflowRuntimeInitializer` provider (`OnModuleInit`) that calls `initialize()` during module init, so a version-bump violation fails application startup rather than the first workflow operation.

**(v7.0.0)** With a `definitionStore` configured, `initialize()` also runs the startup executability check: for every stored definition version that still has active (non-terminal) instances, it verifies every referenced command and guard is registered and that the snapshot is structurally valid (e.g. a 6.x snapshot with a `$`-prefixed event name fails). `onUnresolvable: "fail"` (the default, on `WorkflowRuntimeOptions` and NestJS's `WorkflowModuleOptions`) throws `WorkflowDefinitionError`; `"warn"` logs and continues. Without a `guardRegistry`, every guard reference counts as missing. An invalid `onUnresolvable` value throws `InvalidArgumentError`. Without an explicit `initialize()` at boot the check runs lazily, and a failure fails every `createInstance`/`triggerEvent`/`processExpiredWorkflows`/`rearmTimeout` call, for every workflow, until fixed.

### Database Setup

```ts
import { generateMigrationSql } from "@duraflows/pg";

const { up, down } = generateMigrationSql(); // PG 13+ (gen_random_uuid)
const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" }); // PG 18+ (time-ordered)
```

Or copy **all** the reference migrations from `node_modules/@duraflows/pg/sql/dbmate/` (`001` through `006`) and apply them in order. `005_timeout_retries.sql` adds the `timeout_*` columns and **must be applied before deploying 6.0.0**: the runtime reads and writes them on every operation. `006_definition_version_index.sql` is recommended, not required: it adds an index that keeps the 7.0.0 startup executability check and `listDefinitionVersions()` cheap on large tables.

---

## WorkflowHandle Pattern

The recommended way to interact with workflow instances:

```ts
const instance = await runtime.createInstance({ workflowName: "order", metadata: { orderId } });
const handle = runtime.getHandle(instance.uuid); // sync, no DB call

const result = await handle.triggerEvent("PaymentReceived", {
  subject: order,
  triggerMetadata: { source: "webhook" },
});

const events = await handle.getAvailableEvents();
const current = await handle.getInstance();
const history = await handle.getHistory({ limit: 10 });
```

In NestJS, use `workflowService.getHandle(uuid)`.

---

## Timeout Processing

Set up an external poller:

```ts
// NestJS
@Cron(CronExpression.EVERY_MINUTE)
async handleTimeouts() {
  await this.timeoutService.processExpiredWorkflows(100);
}

// Standalone
await runtime.processExpiredWorkflows({ limit: 100 });
```

Returns:

```ts
interface ProcessExpiredWorkflowsResult {
  processed: number;
  rejected: number; // v1.1.0
  businessFailed: Array<{ uuid: string; finalState: string }>;
  failed: Array<{ uuid: string; error: string; attempts?: number; retryAt?: Date | null }>; // attempts/retryAt: v6.0.0
  parked: Array<{ uuid: string; error: string }>; // v6.0.0
}
```

v1.1.0: a timeout-driven event whose guard returns `false` is counted as `rejected` (not `processed`); the runtime clears `expiresAt` so the next sweep won't re-pick the instance until something else updates the deadline. `businessFailed` lists processed instances whose commands failed and routed to an `errorState` -- a successful transition, not a timeout failure.

### Retries and parking (v6.0.0)

`failed` lists instances whose timeout transaction threw (a command threw, `CommandFailureError`, a missing definition, a database error) and rolled back. The runtime records each failure on `instance.timeoutRetry` (`{ attempts, lastError, retryAt, parkedAt }`) in a second small transaction: `attempts` and `retryAt` on the `failed` entry report it (`retryAt: null` when this failure parked the instance). Sweeps skip the instance until `retryAt`, so failing instances move behind healthy ones. After `maxAttempts` consecutive failures the instance is **parked**: it keeps its state and deadline, appears in `parked`, and no sweep picks it up again. Any successful transition (including a manual `triggerEvent()`) clears `timeoutRetry`. Failed attempts write no history rows.

Tune the backoff with the `timeoutRetry` runtime option (every value a positive safe integer, `initialDelayMs <= maxDelayMs`, or the constructor throws `InvalidArgumentError`):

```ts
new WorkflowRuntime({
  // ...
  timeoutRetry: { initialDelayMs: 60_000, maxDelayMs: 3_600_000, maxAttempts: 10 }, // the defaults
});
```

Operators list parked instances, fix the cause, then re-arm them:

```ts
const parked = await runtime.findParkedTimeouts({ workflowName: "order", limit: 50 }); // oldest-parked first; limit defaults to 100
await runtime.rearmTimeout(parked[0].uuid); // clears timeoutRetry; the next sweep retries it
```

In NestJS, pass `timeoutRetry` in `WorkflowModule.forRoot({ ... })` or in the `forRootAsync` factory's return value; `WorkflowTimeoutService` exposes the same `findParkedTimeouts(input?)` and `rearmTimeout(uuid)`. `rearmTimeout` throws `WorkflowInstanceNotFoundError` for an unknown UUID and returns an instance without retry state unchanged. `timeoutRetry.lastError` holds the raw error message (truncated to 2000 characters), which may include internal details.

---

## Error Hierarchy

| Error                         | When Thrown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowError`               | Instance not found, optimistic lock failure, command not in registry, **(v1.1.0)** guard ref not in registry, **(v7.1.0)** `migrateInstances`/`listDefinitionVersions` without a `definitionStore`, or `migrateInstances` without `instanceUuids` when the store lacks `findInstanceUuids`                                                                                                                                                                                                                                                                                       |
| `WorkflowDefinitionError`     | Invalid/duplicate definition, unknown workflow name, **(v1.1.0)** unresolved `guard.name` ref at registration when `knownGuardNames` was supplied, **(v5.0.0)** a registered definition's content changed without a version bump (detected by `initialize()`'s content-hash comparison), **(v7.0.0)** the startup executability check found an unregistered command/guard or a structurally invalid snapshot (`onUnresolvable: "fail"`), or a pinned instance's stored snapshot is missing/invalid, or **(v7.1.0)** `migrateInstances`'s `toVersion` not in the definition store |
| `InvalidEventError`           | Event not available on current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `IncompatibleDefinitionError` | **(v7.0.0)** Under `versionPolicy: "latest"`, an instance's current state doesn't exist in the latest registered definition                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CommandFailureError`         | Command returned `{ ok: false }` with no `errorState` defined (note: guard rejections don't throw — see Outcome rules)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `OnEnterDepthExceededError`   | onEnter chain exceeded `maxOnEnterDepth`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MigrationInterruptedError`   | **(v7.2.0)** `migrateInstances` failed while listing candidates -- `findInstanceUuids` rejected, or returned a bad page; `error.result` holds the partial result, `error.cause` the original error                                                                                                                                                                                                                                                                                                                                                                               |

All extend `WorkflowError` which extends `Error`.

---

## Anti-Patterns

- Using `Date.now()` or `new Date()` instead of `ctx.now` in commands
- Storing non-serializable values in context (class instances, functions, Date objects)
- Forgetting `errorState` on events whose **mandatory** commands can fail
- Storing large payloads in context instead of IDs/references
- Creating deep onEnter chains without considering the depth limit
- Calling external APIs without idempotency keys
- Throwing exceptions for business failures instead of returning `{ ok: false }`
- Mutating `ctx.metadata` — it's `deepFreeze`d, so under strict mode the assignment throws `TypeError`. ESM source files run in strict mode by default, so in practice you get a runtime error, not a silent no-op. Write through `ctx.context` instead.
- (v1.0.0) Catching errors and returning `{ ok: true }` from a notification/metric/compensation command — use `bestEffort = true` instead, so the failure is recorded honestly without aborting the chain
- (v1.0.0) Doing business-critical work in an observer — observers are post-commit and at-most-once; use a workflow command if the work must run inside the transaction or must retry
- (v1.0.0) Putting `observers` at the top level of `WorkflowModule.forRootAsync` — it was removed; return them from `useFactory` inside `WorkflowModuleFactoryConfig`
- (v1.1.0) Mutating `ctx.context` from inside a `WorkflowGuard.evaluate` — the runtime hands you a `deepFreeze`d clone; mutations throw under strict mode. Move side effects into a command that runs after the guard passes
- (v1.1.0) Calling external services or DBs from a guard — guards re-run on timeout sweeps and inside the same transaction; non-idempotent I/O will repeat. Compute the predicate from `subject` + `ctx.context` + `ctx.commandMetadata` only
- (v1.1.0) Routing a guard rejection to `errorState` — `errorState` catches **command** failures only. A guard rejection means "not allowed right now"; either let the caller try again or model the rejection as an explicit alternate event
- (v1.1.0) Asserting on a guard implementation's `.name` property in tests of `rejectedBy` — the runtime reports the **declared `eventDef.guard.name` ref** (definition is the source of truth). With aliasing custom registries the two can diverge
- (v1.1.0) Passing both `guards` and `guardRegistry` to `WorkflowModule.forRoot[Async]` — they're mutually exclusive and the module throws synchronously if both are present
- (v5.0.0) Changing a definition's content but forgetting to bump `version` — `WorkflowRuntime.initialize()` detects the content-hash mismatch and throws `WorkflowDefinitionError`. The failure is loud, not silent -- but only if `initialize()` actually runs before the drifted definition serves traffic, which is why calling it explicitly at boot (rather than relying on lazy invocation) is recommended
- (v7.0.0) Deleting a command or guard that an old, still-pinned definition version still references before that version has drained — check `runtime.listDefinitionVersions(name)` for `activeInstances === 0` first, or the startup executability check fails boot (or warns, under `onUnresolvable: "warn"`)
- (v7.0.0) Assuming `versionPolicy: "latest"` is per-instance — it's the **latest registered definition's** policy that governs every instance of that workflow. Flipping it doesn't require a version bump (it's excluded from the content hash), but it changes behavior for every in-flight instance at once
- (v7.0.0) Naming a workflow event starting with `"$"` — reserved for system events; validation rejects the definition
- (v7.1.0) Expecting `migrateInstances` to run `onEnter`, commands or guards, or to re-check the startup executability check — it does neither; it is pure relabeling and awaits only the definition sync half of `initialize()`
- (v7.1.0) Writing an impure `transformContext` — it must be pure. **(v7.2.0)** Returning something other than a plain object from it now fails that instance loudly (`transformContext must return a plain object`) instead of silently mangling it through `JSON.parse(JSON.stringify(...))`; a plain object's contents still round-trip through JSON, so a `Date` _inside_ it still comes back as its JSON form, not itself
- (v7.2.0) Passing `cursor` together with `instanceUuids` — they're mutually exclusive (`InvalidArgumentError("cursor cannot be combined with instanceUuids")`); paging by cursor only makes sense against `findInstanceUuids`
- (v7.2.0) Catching `MigrationInterruptedError` and checking `error instanceof <YourStoreError>` — that's always `false`; the store's error is wrapped as `error.cause`, so check `error.cause instanceof <YourStoreError>` instead

---

## Reference

For complete API type signatures and detailed behavioral specifications, see [api-reference.md](../../references/api-reference.md).
