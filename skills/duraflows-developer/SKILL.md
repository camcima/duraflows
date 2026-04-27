---
name: duraflows-developer
description: "Provides domain expertise for developing durable workflows with @duraflows/core, @duraflows/pg, and @duraflows/nestjs. Use when writing, reviewing, or debugging code that imports duraflows packages, defines WorkflowDefinition objects, implements WorkflowCommand handlers, configures WorkflowModule, or works with workflow states, events, commands, timeouts, or onEnter chains."
---

# duraflows Developer Guide

## Architecture

duraflows is a **durable workflow runtime** for TypeScript built on [@camcima/finita](https://github.com/camcima/finita) (FSM engine). Three packages:

| Package             | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `@duraflows/core`   | Framework-agnostic runtime, types, persistence interfaces  |
| `@duraflows/pg`     | PostgreSQL adapter (SKIP LOCKED, JSONB, row-level locking) |
| `@duraflows/nestjs` | NestJS module with DI, services, optional REST controllers |

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
  initialState: "new", // must exist in states
  states: {
    new: {
      /* WorkflowStateDefinition */
    },
    processing: {
      /* ... */
    },
    completed: {}, // terminal state (no events)
  },
};
```

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
- **`timeout`**: Auto-trigger after duration. Fields `afterMinutes`, `afterHours`, `afterDays` are **additive**
- **`metadata`**: Arbitrary event metadata

**v1.0.0:** an event must define **at least one** of `targetState`, `errorState`, or `commands`. Three valid shapes:

| Shape               | Has `targetState`? | Has `errorState`? | Has `commands`? | Use case                                                                                             |
| ------------------- | ------------------ | ----------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Standard transition | ✓                  | optional          | optional        | Most events                                                                                          |
| Command-only event  | ✗                  | ✗                 | ✓               | Side-effect actions (notes, manual corrections, side-effect kicks) — workflow stays in current state |
| Failure-only event  | ✗                  | ✓                 | ✓               | Trap a failure, route to recovery without forward progress                                           |

**Outcome rules** (mandatory commands; see [bestEffort](#besteffort-commands) for the relaxed semantics):

| Scenario                                                             | Result                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| No commands                                                          | `success` -> `targetState` (or stays if no `targetState`) |
| All commands return `{ ok: true }`                                   | `success` -> `targetState` (or stays)                     |
| Any mandatory command returns `{ ok: false }` + `errorState` defined | `failure` -> `errorState`                                 |
| Any mandatory command returns `{ ok: false }` + no `errorState`      | Throws `CommandFailureError`, no transition               |
| Any mandatory command throws                                         | Exception propagates, transaction rolls back              |

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
import { WorkflowRuntime, InMemoryDefinitionRegistry, InMemoryCommandRegistry } from "@duraflows/core";
import { pgWorkflowProviders } from "@duraflows/pg";

const persistence = pgWorkflowProviders(pool);
const definitionRegistry = new InMemoryDefinitionRegistry();
definitionRegistry.register(orderWorkflow);

const commandRegistry = new InMemoryCommandRegistry();
commandRegistry.register("chargePayment", new ChargePaymentCommand(gateway));

const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  ...persistence,
  clock: { now: () => new Date() },
});
```

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

Returns `{ processed: number, failed: Array<{ uuid, error }> }`.

---

## Error Hierarchy

| Error                       | When Thrown                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `WorkflowError`             | Instance not found, optimistic lock failure, command not in registry |
| `WorkflowDefinitionError`   | Invalid/duplicate definition, unknown workflow name                  |
| `InvalidEventError`         | Event not available on current state                                 |
| `CommandFailureError`       | Command returned `{ ok: false }` with no `errorState` defined        |
| `OnEnterDepthExceededError` | onEnter chain exceeded `maxOnEnterDepth`                             |

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
- Mutating `ctx.metadata` (it's frozen -- writes are silently ignored)
- (v1.0.0) Catching errors and returning `{ ok: true }` from a notification/metric/compensation command — use `bestEffort = true` instead, so the failure is recorded honestly without aborting the chain
- (v1.0.0) Doing business-critical work in an observer — observers are post-commit and at-most-once; use a workflow command if the work must run inside the transaction or must retry
- (v1.0.0) Putting `observers` at the top level of `WorkflowModule.forRootAsync` — it was removed; return them from `useFactory` inside `WorkflowModuleFactoryConfig`

---

## Reference

For complete API type signatures and detailed behavioral specifications, see [api-reference.md](../../references/api-reference.md).
