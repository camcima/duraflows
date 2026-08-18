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

At startup -- or lazily, on the first `createInstance`/`triggerEvent`/`processExpiredWorkflows` call if `initialize()` was never invoked -- `WorkflowRuntime.initialize()` snapshots every registered definition into the `workflow_definitions` table (via the optional `definitionStore`) and compares content hashes against what's already stored. If a previously-registered `(workflowName, version)` now has different content, it throws `WorkflowDefinitionError` instead of silently running drifted logic. `initialize()` is idempotent: concurrent and repeated calls share one sync, and a failed sync is not cached, so the next call retries.

Instances and history rows record the version that governed them: `WorkflowInstance.definitionVersion` and `WorkflowHistoryRecord.definitionVersion`. Both are stamped at creation and re-stamped on every transition. `null` marks a legacy row that predates versioning; it picks up a real version stamp on its next transition.

**Resolution is unchanged in 5.0.0.** Every instance -- new or in-flight -- still executes the _currently registered_ definition, regardless of which version it's stamped with. The stamp is provenance only, not pinning. Version-pinned execution (running an instance against the exact definition content it was created under) is planned for a later release.

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
- Uses `FOR UPDATE SKIP LOCKED` in PostgreSQL for concurrent worker safety
- Timeout events fire with `triggerMetadata: { source: "timeout" }`

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

`forRootAsync` is generic over the factory's argument tuple. Declaring `<TArgs>` typechecks `inject` against `useFactory` parameters at compile time. Observers, `onObserverError`, and `clock` go in the factory's return value (the `WorkflowModuleFactoryConfig`) so they can compose from injected services.

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

**Observer DI scope gotcha:** the `forRootAsync` factory can only inject providers that are global, declared in this module's `imports`, or exported by modules listed there. If your observer is a NestJS provider in the consuming module, bundle it in its own module:

```ts
@Module({ providers: [OrderAuditObserver], exports: [OrderAuditObserver] })
class OrderObserversModule {}

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

### Database Setup

```ts
import { generateMigrationSql } from "@duraflows/pg";

const { up, down } = generateMigrationSql(); // PG 13+ (gen_random_uuid)
const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" }); // PG 18+ (time-ordered)
```

Or copy the reference migration from `node_modules/@duraflows/pg/sql/dbmate/001_workflow_core.sql`.

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

Returns `{ processed: number, rejected: number (v1.1.0), failed: Array<{ uuid, error }> }`. v1.1.0: a timeout-driven event whose guard returns `false` is counted as `rejected` (not `processed`); the runtime clears `expiresAt` so the next sweep won't re-pick the instance until something else updates the deadline.

---

## Error Hierarchy

| Error                       | When Thrown                                                                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowError`             | Instance not found, optimistic lock failure, command not in registry, **(v1.1.0)** guard ref not in registry                                                                                                                                                                            |
| `WorkflowDefinitionError`   | Invalid/duplicate definition, unknown workflow name, **(v1.1.0)** unresolved `guard.name` ref at registration when `knownGuardNames` was supplied, **(v5.0.0)** a registered definition's content changed without a version bump (detected by `initialize()`'s content-hash comparison) |
| `InvalidEventError`         | Event not available on current state                                                                                                                                                                                                                                                    |
| `CommandFailureError`       | Command returned `{ ok: false }` with no `errorState` defined (note: guard rejections don't throw — see Outcome rules)                                                                                                                                                                  |
| `OnEnterDepthExceededError` | onEnter chain exceeded `maxOnEnterDepth`                                                                                                                                                                                                                                                |

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

---

## Reference

For complete API type signatures and detailed behavioral specifications, see [api-reference.md](../../references/api-reference.md).
