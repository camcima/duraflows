---
name: duraflows-builder
description: "Builds complete duraflows workflow implementations from natural-language requirements. Use when the user asks to create, design, or scaffold a workflow, or says 'build me a workflow for X', 'I need a workflow that does Y', 'create a state machine for Z', or wants to model a business process with duraflows."
---

# duraflows Workflow Builder

A step-by-step reasoning process for translating natural-language requirements into complete duraflows workflow implementations.

---

## Reasoning Checklist

Follow these steps in order when a user asks you to build a workflow.

### Step 1: Extract Domain Entities and Actions

From the user's description, identify:

- **Main entity**: What is being tracked? (order, ticket, document, deployment, etc.)
- **Lifecycle stages**: What distinct phases does it go through?
- **External actions**: What side effects happen? (API calls, notifications, payments)
- **Failure modes**: What can go wrong at each stage?
- **Time-sensitive transitions**: Are there deadlines or auto-escalations?
- **Human decision points**: Where does a person need to approve or decide?

### Step 2: Map to States

Each distinct lifecycle stage becomes a state in the `WorkflowDefinition`:

- **Active states**: Have events (the workflow can progress)
- **Terminal states**: No events (the workflow is done). Define as empty objects `{}`
- **Gateway states**: Use `onEnter` to auto-execute commands and transition (no human trigger needed)
- **Waiting states**: Have events but no `onEnter` (waiting for external trigger or timeout)

**Keep states minimal.** Each state should represent a genuinely distinct lifecycle phase. Don't add intermediate or "final" wrapper states unless they serve a specific purpose (running commands, branching, enabling retry). If a single terminal state like `cancelled` or `failed` is sufficient, use it directly — don't split it into `cancelling` + `cancelled_final`.

For each state, determine what `context` values should be set on entry (status flags, timestamps).

### Step 3: Map to Events

Each user action, external trigger, or automated transition becomes an event:

- Determine `targetState` (where does success lead?). **v1.0.0:** `targetState` is now optional — see _command-only events_ below.
- Does this event involve commands that can fail? If yes, define `errorState` (or mark non-critical commands as `bestEffort` — see Step 4c).
- Is this event time-triggered? Define `timeout` with `afterMinutes`/`afterHours`/`afterDays`
- Is the event gated by a precondition that should run **before** any commands? Define a `guard` (v1.1.0). See Step 4d.
- Remember: at most **one timeout event per state**

**Event shapes (v1.0.0):** an event must define at least one of `targetState`, `errorState`, or `commands`. Three valid combinations:

| Shape                                                | Use case                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `targetState` (+ optional `errorState` + `commands`) | Standard transition — most events                                                                                                       |
| `commands` only (no `targetState`)                   | Command-only event — runs side effects, stays in current state. Right for operator notes, manual context corrections, side-effect kicks |
| `errorState` + `commands` (no `targetState`)         | Failure-only event — trap a failure and route to recovery without forward progress                                                      |

**v2.0.0 — merged self-loop is allowed.** When `targetState` and `errorState` point at the same state (typically the current state, e.g., `poll: { targetState: "active", errorState: "active" }`), `WorkflowCompiler` collapses the two branches into a single transition at compile time. Both outcomes resolve to that state and the result still distinguishes `outcome: "success"` vs `"failure"` for history. Use this shape for "stay here regardless of outcome, just record what happened" — typical for polling, idempotent retries, and best-effort tick events.

### Step 4: Map to Commands

Each side-effecting action becomes a `WorkflowCommand`:

- Name with verb-noun pattern: `chargePayment`, `sendNotification`, `validateInventory`
- Determine what each command reads from `ctx.metadata` (identity) and `ctx.context` (working state)
- Determine what each command writes to `ctx.context`
- Commands execute sequentially in definition order; first failure stops the chain

### Step 4b: Best-Effort Commands (v1.0.0)

For non-critical side effects — notifications, metrics, analytics, compensation/rollback steps — set `bestEffort = true` on the command class:

```ts
class SendNotificationCommand implements WorkflowCommand {
  readonly bestEffort = true;
  async execute(subject, ctx): Promise<CommandResult> {
    /* ... */
  }
}
```

A best-effort command:

- Returning `{ ok: false }` does NOT abort the chain or taint `outcome`. The result is recorded; the next command runs.
- Throwing is caught and recorded as `{ ok: false, code: "BEST_EFFORT_THROWN", error: { name, message, stack? } }`. The chain continues.

**Decision matrix:**

| Concern                                                  | Right tool                          |
| -------------------------------------------------------- | ----------------------------------- |
| Failure must abort the workflow                          | Mandatory command (no `bestEffort`) |
| Failure should route to a recovery state                 | Mandatory command + `errorState`    |
| Failure should be recorded but not stop forward progress | `bestEffort: true`                  |
| Cross-cutting audit / metric of every state entry        | Observer (post-commit, see Step 9b) |

This replaces the v0.x pattern of "catch the error inside the command and return `{ ok: true }` anyway". Returning `ok: true` lies in the history; `bestEffort: true` records the truth and continues.

### Step 4c: Per-Command Metadata (v1.0.0)

Add `metadata` to a `WorkflowCommandRef` to drive one handler with different parameters from many call sites:

```ts
commands: [
  { name: "send-notification", metadata: { channel: "email", template: "payment-confirmed" } },
  { name: "send-notification", metadata: { channel: "sms", template: "delivered" } },
];
```

Inside the handler, read `ctx.commandMetadata.channel` etc. Each ref's metadata is deep-cloned + frozen, isolated from siblings.

### Step 4d: Event Guards (v1.1.0)

For preconditions that gate an event **before any commands run**, use a `WorkflowGuard` instead of a routing `errorState`. A guard is a read-only predicate; if it returns `false`, the event short-circuits with `outcome: "guard-rejected"`, no commands execute, no state change.

```ts
class IsVerifiedGuard implements WorkflowGuard<Customer> {
  readonly name = "isVerified";
  evaluate(subject: Customer, ctx: WorkflowExecutionContext): boolean {
    return subject.verified === true;
  }
}

// In the workflow:
events: {
  Submit: {
    guard: { name: "isVerified" },          // ref name resolved against the guard registry
    targetState: "submitted",
    commands: [{ name: "createOrder" }],
  },
}
```

**When a guard is the right choice:**

- The decision is read-only ("is this allowed right now?") — no I/O, no DB writes
- Rejection is normal business behavior (the caller can try again later or pick a different event)
- You want to short-circuit **before** any side effects run
- The same logic applies to multiple events (define once, reference from many)

**Choose `errorState` instead when** the failure represents a fault to capture, the workflow needs an alternate path with full command results recorded, or the decision depends on side-effecting work (an external check, a DB lookup that can't be precomputed into context).

**Per-event metadata.** Like commands, a guard ref can carry metadata that reaches the implementation through `ctx.commandMetadata` (deep-cloned + frozen). Use this so one `WorkflowGuard` implementation can serve many call sites:

```ts
events: {
  ApplyDiscount: { guard: { name: "minTier", metadata: { minTier: "gold" } }, /* ... */ },
  Refund:        { guard: { name: "minTier", metadata: { minTier: "silver" } }, /* ... */ },
}
```

**Critical constraints (the runtime enforces these):**

- The guard receives a `deepFreeze`d clone of `ctx.context`. Any mutation throws under strict mode.
- Guards run inside the per-event transaction. Do not call external services or write to DBs from a guard — non-idempotent I/O will repeat on timeout sweeps.
- `errorState` does NOT catch guard rejections. They are not faults.
- The guard ref name (`eventDef.guard.name`) is what appears in `WorkflowExecutionResult.rejectedBy` and the history `rejected_by` column — definitions are the source of truth.

**Timeout interaction.** When a guard rejects a timeout-driven event, the runtime additionally clears `expiresAt` so the next sweep won't re-pick the instance. The rejection counts toward `ProcessExpiredWorkflowsResult.rejected`, not `processed`.

### Step 4e: Conditional Branching

duraflows doesn't have a native "if/else" transition from a single command result. Use these patterns:

**Pattern A: errorState as branch.** A gateway state with `onEnter` runs a command. `ok: true` follows `targetState`, `ok: false` follows `errorState`. This is the idiomatic pattern for binary branching (e.g., "if flagged go to review, otherwise auto-approve").

```ts
scanning: {
  onEnter: {
    commands: ["aiScan"],
    targetState: "approved",     // scan clean -> auto-approve
    errorState: "pending_review", // scan flagged -> human review
  },
},
```

The `aiScan` command returns `{ ok: false, code: "FLAGGED" }` to route to review. This is not an error — it's intentional routing using the `ok: false` / `errorState` mechanism.

**Trade-off: Pattern A uses the single `errorState` slot for branching, so actual infrastructure failures (e.g., scan service down) can't route to a separate error state at the state machine level.** Handle infrastructure errors inside the command itself: catch them, retry if appropriate, and if unrecoverable, either re-throw (which rolls back the transaction and leaves the workflow in the current state for retry) or return `{ ok: false }` with a distinguishing code and a context flag:

```ts
// Inside the aiScan command:
try {
  const result = await this.aiService.scan(content);
  if (result.flagged) {
    ctx.context.scanOutcome = "flagged";
    return { ok: false, code: "FLAGGED" };
  }
  ctx.context.scanOutcome = "clean";
  return { ok: true, code: "CLEAN" };
} catch (err) {
  // Infrastructure failure — re-throw to roll back transaction.
  // The workflow stays in the current state; the event can be retried.
  throw err;
}
```

**Pattern B: Two events for explicit triggers.** When the branch depends on an external decision (not a command result), use separate events on a waiting state:

```ts
pending_review: {
  events: [
    { name: "approve", targetState: "approved" },
    { name: "reject", targetState: "rejected", commands: ["notifyAuthor"] },
  ],
},
```

Prefer Pattern A for automated decisions and Pattern B for human decisions. Don't add unnecessary routing gateway states when a single `onEnter` with `targetState`/`errorState` achieves the branch directly.

### Step 5: Design Error Recovery

For each command that can fail:

- Define an `errorState` on the event
- Consider retry patterns: `errorState` with a `Retry` event that transitions back
- Track retry count in context: `ctx.context.retryCount = (ctx.context.retryCount ?? 0) + 1`
- Consider compensation (saga): if step N fails, do previous steps need rollback? See [saga template](./assets/saga-compensation.ts)

### Step 6: Design Timeout Patterns

For waiting states that need deadlines:

- Auto-close: `timeout: { afterDays: 30 }` -> terminal state
- Escalation: `timeout: { afterHours: 48 }` -> escalated state with force-approve/reject events
- Reminder: `timeout: { afterDays: 1 }` -> gateway state that sends reminder then returns to waiting

### Step 7: Assemble the WorkflowDefinition

Give the assembled definition an explicit `version` (a positive integer, defaults to `1` if omitted):

```ts
export const myWorkflow: WorkflowDefinition = {
  name: "my-workflow",
  version: 1,
  initialState: "...",
  states: {/* ... */},
};
```

**(v5.0.0)** Bump `version` whenever you change the definition's content (states, events, commands) after it has already shipped — `WorkflowRuntime.initialize()` detects a content change under an unbumped version and throws `WorkflowDefinitionError`. A first-time build doesn't need to worry about this; it matters from the second deploy onward. See the duraflows-developer skill for the full mechanics.

Use the skeleton templates as starting points:

- [Simple sequence](./assets/simple-sequence.ts) -- linear progression with timeout
- [Fan-out/fan-in](./assets/fan-out-fan-in.ts) -- multi-step processing via onEnter chains
- [Saga with compensation](./assets/saga-compensation.ts) -- forward chain + rollback
- [Approval / human-in-the-loop](./assets/approval-human-in-loop.ts) -- waiting states with escalation

### Step 8: Implement Commands

For each command name referenced in the definition:

**NestJS pattern:**

```ts
import { WorkflowCommand } from "@duraflows/nestjs";

@WorkflowCommand("chargePayment")
export class ChargePaymentCommand implements WorkflowCommandInterface {
  constructor(private readonly gateway: PaymentGateway) {}

  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    try {
      const result = await this.gateway.charge(/* ... */);
      ctx.context.chargeId = result.id;
      ctx.context.chargedAt = ctx.now.toISOString();
      return { ok: true, code: "CHARGED" };
    } catch (err) {
      return { ok: false, code: "CHARGE_FAILED", message: String(err) };
    }
  }
}
```

**Standalone pattern:**

```ts
const commandRegistry = new InMemoryCommandRegistry();
commandRegistry.register("chargePayment", new ChargePaymentCommand(gateway));
```

### Step 9: Wire Up

**NestJS (sync):**

```ts
WorkflowModule.forRoot({
  workflows: [myWorkflow],
  persistence: pgWorkflowProviders(pool),
  observers: [auditObserver], // v1.0.0: top-level for forRoot only
  guards: [new IsVerifiedGuard()], // v1.1.0: array form composes an InMemoryGuardRegistry; OR pass guardRegistry (mutually exclusive)
});
```

**NestJS (async, v1.0.0):**

```ts
WorkflowModule.forRootAsync<[pg.Pool, AuditObserver]>({
  imports: [ObserversModule], // observer DI must be visible to the dynamic-module factory
  useFactory: (pool, audit) => ({
    workflows: [myWorkflow],
    persistence: pgWorkflowProviders(pool),
    observers: [audit], // v1.0.0: observers go INSIDE useFactory return value
    guards: [new IsVerifiedGuard()], // v1.1.0; or guardRegistry — never both
    onObserverError: (err, obs, evt) => logger.warn(`${obs.name} failed: ${err}`),
  }),
  inject: [PG_POOL, AuditObserver],
});
```

**Standalone:**

```ts
const guardRegistry = new InMemoryGuardRegistry(); // v1.1.0: only required if any event uses a guard
guardRegistry.register("isVerified", new IsVerifiedGuard());

const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  guardRegistry, // omit if no events declare a guard
  ...pgWorkflowProviders(pool),
  clock: { now: () => new Date() },
  observers: [auditObserver],
  onObserverError: (err, obs, evt) => logger.warn(`${obs.name} failed: ${err}`),
});
```

If the workflow uses timeouts, set up a poller:

```ts
// NestJS: @Cron(CronExpression.EVERY_MINUTE)
await timeoutService.processExpiredWorkflows(100);
```

### Step 9b: Add Observers (v1.0.0)

For audit trails, metrics, projections, cache invalidation, or webhooks, register a `WorkflowObserver`:

```ts
const auditObserver: WorkflowObserver = {
  name: "audit",
  onEnter: async (event) => {
    await audit.record({
      workflow: event.workflowName,
      instance: event.instanceUuid,
      from: event.fromState,
      to: event.toState,
      via: event.triggerEvent,
      transitionUuid: event.transitionUuid,
      at: event.occurredAt,
    });
  },
};
```

Observers fire **post-commit, at-most-once, sequential, error-contained**. They are NOT a place for business-critical work — use a workflow command if the work must run inside the transaction or must retry on failure.

`event.transitionUuid` matches the `transitionUuid` on the `WorkflowExecutionContext` of commands that ran on entry to the same state, so observer logs and command logs can be correlated 1:1.

---

## Requirement-to-Primitive Mapping

| User Says                                                                 | duraflows Primitive                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "when X happens"                                                          | Event on a state                                                                                            |
| "then do Y"                                                               | Command in event's `commands` list                                                                          |
| "if Y fails, go to Z"                                                     | `errorState` on the event                                                                                   |
| "wait for X"                                                              | State with events but no `onEnter`                                                                          |
| "automatically do X when entering state"                                  | `onEnter` with commands                                                                                     |
| "if nothing happens in N hours/days"                                      | Timeout event: `timeout: { afterHours: N }`                                                                 |
| "retry up to N times"                                                     | `errorState` -> state with Retry event, `retryCount` in context                                             |
| "poll/tick/heartbeat — stay here regardless of outcome, just record it"   | Merged self-loop event: `targetState` and `errorState` both equal current state (v2.0.0)                    |
| "do X, then Y, then Z automatically"                                      | onEnter chain: gateway1 -> gateway2 -> gateway3                                                             |
| "if any step fails, undo previous steps"                                  | Saga: error states with compensation onEnter chains; mark cancel/rollback commands `bestEffort: true`       |
| "needs human approval"                                                    | Waiting state with Approve/Reject events                                                                    |
| "escalate after N hours"                                                  | Timeout event -> escalated state                                                                            |
| "track who did it"                                                        | `triggerMetadata: { actor: userId }` (stored in history)                                                    |
| "set status to X in this state"                                           | `context: { status: "X" }` on state definition                                                              |
| "remember the result for later"                                           | Command writes to `ctx.context`                                                                             |
| "identify by order ID"                                                    | `metadata: { orderId }` at creation (immutable)                                                             |
| "send a notification but don't fail the order if email is down"           | `bestEffort: true` on the notification command (v1.0.0)                                                     |
| "let an operator add a note without changing state"                       | Command-only event — `commands` only, no `targetState` (v1.0.0)                                             |
| "use the same handler with different parameters at different call sites"  | Per-`WorkflowCommandRef.metadata`, read via `ctx.commandMetadata` (v1.0.0)                                  |
| "log/audit every state transition"                                        | Register a `WorkflowObserver` (v1.0.0) — post-commit, at-most-once                                          |
| "only allow this event if the user is verified / cart total ≥ N / etc."   | `guard: { name: "..." }` on the event (v1.1.0) — read-only predicate, runs before any commands              |
| "block the timeout from auto-progressing until X is true"                 | Same event guard; on timeout the runtime additionally clears `expiresAt` to avoid sweep churn (v1.1.0)      |
| "the same precondition with different thresholds at different call sites" | One `WorkflowGuard` implementation; pass `guard.metadata: { ... }`, read via `ctx.commandMetadata` (v1.1.0) |
| "the rejection should NOT be treated as an error"                         | Use a `guard` rather than an `errorState` — `errorState` catches command failures only (v1.1.0)             |

---

## Skeleton Templates

Start from the template closest to your use case:

| Template                                                        | Pattern                   | When to Use                                      |
| --------------------------------------------------------------- | ------------------------- | ------------------------------------------------ |
| [simple-sequence.ts](./assets/simple-sequence.ts)               | Linear state progression  | Straightforward lifecycle with sequential stages |
| [fan-out-fan-in.ts](./assets/fan-out-fan-in.ts)                 | Multi-step onEnter chains | Processing pipelines, multi-stage enrichment     |
| [saga-compensation.ts](./assets/saga-compensation.ts)           | Forward + rollback chains | Multi-service transactions needing rollback      |
| [approval-human-in-loop.ts](./assets/approval-human-in-loop.ts) | Waiting states + timeout  | Approval flows, review processes, escalation     |
