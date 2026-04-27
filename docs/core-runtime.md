# Core Runtime API

The `@duraflows/core` package provides the framework-agnostic workflow runtime, types, validation, compilation, and execution engine.

## WorkflowRuntime

The main entry point for all workflow operations.

```ts
import { WorkflowRuntime } from "@duraflows/core";
```

### Constructor

```ts
new WorkflowRuntime(options: WorkflowRuntimeOptions)
```

**WorkflowRuntimeOptions:**

| Property             | Type                          | Description                                                                                            |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `definitionRegistry` | `WorkflowDefinitionRegistry`  | Registry of workflow definitions                                                                       |
| `commandRegistry`    | `WorkflowCommandRegistry`     | Registry of command handlers                                                                           |
| `instanceStore`      | `WorkflowInstanceStore`       | Persistence for workflow instances                                                                     |
| `historyStore`       | `WorkflowHistoryStore`        | Persistence for history records                                                                        |
| `transactionRunner`  | `WorkflowTransactionRunner`   | Transaction management                                                                                 |
| `clock`              | `WorkflowClock`               | Clock for timestamps (injectable for testing)                                                          |
| `maxOnEnterDepth`    | `number`                      | Maximum depth for onEnter auto-transition chains (default: 10)                                         |
| `observers`          | `readonly WorkflowObserver[]` | Optional observers notified post-commit on every state entry                                           |
| `guardRegistry`      | `WorkflowGuardRegistry`       | Optional registry of guard implementations; required when any workflow definition references a `guard` |

### createInstance()

Creates a new workflow instance at the initial state.

```ts
async createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance>
```

**Parameters:**

| Property          | Type                      | Required | Description                                                                                                                                           |
| ----------------- | ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowName`    | `string`                  | Yes      | Must match a registered workflow definition                                                                                                           |
| `context`         | `Record<string, unknown>` | No       | Initial mutable context data. Merged with state-defined context on entry. See [Context and Metadata](./workflow-definitions.md#context-and-metadata). |
| `metadata`        | `Record<string, unknown>` | No       | Immutable identity labels (e.g., `{ orderId: "..." }`). Never modified after creation.                                                                |
| `triggerMetadata` | `Record<string, unknown>` | No       | Optional metadata about who/what created the instance                                                                                                 |

**Behavior:**

1. Resolves the workflow definition from the registry (already validated and compiled at registration time)
2. Seeds context from the initial state's defaults first, then merges `input.context` on top (user input wins)
3. Computes timeout deadline for the initial state (if applicable)
4. Persists via `instanceStore.create()`
5. If the initial state has an `onEnter` definition, processes the onEnter chain (runs inside a transaction). See [onEnter](./workflow-definitions.md#workflowonenterdefinition).

**Returns:** The created `WorkflowInstance` (reflecting the final state after any onEnter chain).

**Example:**

```ts
const instance = await runtime.createInstance({
  workflowName: "order",
  metadata: { orderId: "ORD-123", customerId: "CUST-456" },
});

console.log(instance.uuid); // "a1b2c3d4-..."
console.log(instance.currentState); // "new"
console.log(instance.version); // 0
```

### triggerEvent()

Triggers an event on a workflow instance, executing commands and transitioning state.

```ts
async triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult>
```

**Parameters:**

| Property               | Type                      | Required | Description                                          |
| ---------------------- | ------------------------- | -------- | ---------------------------------------------------- |
| `workflowInstanceUuid` | `string`                  | Yes      | The instance to trigger the event on                 |
| `eventName`            | `string`                  | Yes      | Must be a valid event on the current state           |
| `subject`              | `unknown`                 | No       | Domain entity passed to command handlers             |
| `triggerMetadata`      | `Record<string, unknown>` | No       | Optional metadata about who/what triggered the event |

**Behavior:**

1. Runs inside `transactionRunner.runInTransaction()`
2. Locks the instance via `instanceStore.lockByUuid()` (row-level lock)
3. Builds `WorkflowExecutionContext` with the instance's `context` (mutable copy) and `metadata` (frozen)
4. Validates event exists on current state (`InvalidEventError` if not)
5. Executes commands sequentially (fail-fast). Commands can read/write `context` and read `metadata`.
6. Determines outcome (`"success"` or `"failure"`)
7. Triggers finita state transition via compiled process
8. Persists context: command mutations first, then new state's `context` merged on top (state context wins)
9. Updates instance (state, version++, context, timeout deadline)
10. Appends history record
11. If the new state has an `onEnter` definition, processes the onEnter chain (each hop updates the instance, appends a history record with `eventName: "onEnter"` and `triggerMetadata: { source: "onEnter" }`, and merges context). See [onEnter](./workflow-definitions.md#workflowonenterdefinition).
12. Returns the final landing state (after any onEnter hops)
13. Commits transaction

**Returns:**

```ts
interface WorkflowExecutionResult {
  outcome: "success" | "failure";
  fromState: string;
  toState: string;
  commandResults: CommandResult[];
  historyUuid: string;
}
```

`outcome` is aggregated across both the event execution and the subsequent onEnter chain:

```
outcome = eventResult.outcome === "failure" || onEnterChain.outcome === "failure"
  ? "failure"
  : "success"
```

- A best-effort command returning `ok: false` does **not** taint `outcome`.
- A mandatory command routing to `errorState` surfaces as `outcome: "failure"` even if subsequent onEnter hops succeed.

**Example:**

```ts
const result = await runtime.triggerEvent({
  workflowInstanceUuid: instance.uuid,
  eventName: "Export",
  subject: orderEntity,
});

console.log(result.outcome); // "success" or "failure"
console.log(result.fromState); // "exportable"
console.log(result.toState); // "exported" or "export_failed"
console.log(result.commandResults.length); // 2
console.log(result.commandResults[0].ok); // true
```

### Guard-rejected outcome

When an event has a `guard` and the guard returns `false`, the runtime returns:

```ts
{
  outcome: "guard-rejected",
  fromState: "<currentState>",
  toState: "<currentState>",   // unchanged
  commandResults: [],
  rejectedBy: "<guard name>",
  historyUuid: "<id of the recorded rejection>",
}
```

A history row is appended (with `outcome = "guard-rejected"` and `rejectedBy` set), but:

- the instance state, version, and context are **not** updated
- `onEnter` chains do **not** run for the unchanged state
- observer `onEnter` events do **not** fire (no transition occurred)

Register guards via the `guardRegistry` option:

```ts
import { InMemoryGuardRegistry, WorkflowRuntime } from "@duraflows/core";

const guardRegistry = new InMemoryGuardRegistry();
guardRegistry.register("submitterIsVerified", {
  name: "submitterIsVerified",
  evaluate: (subject, ctx) => ctx.context.submitterVerified === true,
});

const runtime = new WorkflowRuntime({
  /* ... */
  guardRegistry,
});
```

### processExpiredWorkflows()

Batch-processes workflow instances whose timeout deadline has passed.

```ts
async processExpiredWorkflows(input?: ProcessExpiredWorkflowsInput): Promise<ProcessExpiredWorkflowsResult>
```

**Parameters:**

| Property | Type     | Default | Description                                |
| -------- | -------- | ------- | ------------------------------------------ |
| `limit`  | `number` | 100     | Maximum instances to process in this batch |

**Behavior:**

1. Opens a single transaction and finds expired instances via `instanceStore.findExpired(limit, now)` (uses `FOR UPDATE SKIP LOCKED` in PostgreSQL). The `now` parameter comes from the injected clock rather than the database's `now()`.
2. Within that same transaction, for each expired instance:
   - Resolves the timeout event name from the current state definition
   - Triggers the event with `triggerMetadata: { source: "timeout" }`
   - If the definition changed and no timeout event exists, clears `expiresAt`
3. Individual instance failures are collected (not thrown). They do not stop the batch.
4. Commits the transaction.

**Returns:**

```ts
interface ProcessExpiredWorkflowsResult {
  processed: number;
  failed: Array<{ uuid: string; error: string }>;
}
```

| Property    | Type                                     | Description                                                |
| ----------- | ---------------------------------------- | ---------------------------------------------------------- |
| `processed` | `number`                                 | Number of successfully processed instances                 |
| `failed`    | `Array<{ uuid: string; error: string }>` | Instances that failed, with their UUIDs and error messages |

**Example:**

```ts
const result = await runtime.processExpiredWorkflows({ limit: 50 });
console.log(`Processed ${result.processed} expired workflows`);
if (result.failed.length > 0) {
  console.warn(`Failed: ${result.failed.map((f) => f.uuid).join(", ")}`);
}
```

### getAvailableEvents()

Returns the events available for a workflow instance in its current state.

```ts
async getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]>
```

**Parameters:**

| Property               | Type     | Required | Description           |
| ---------------------- | -------- | -------- | --------------------- |
| `workflowInstanceUuid` | `string` | Yes      | The instance to query |

**Returns:**

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

**Example:**

```ts
const events = await runtime.getAvailableEvents({
  workflowInstanceUuid: instance.uuid,
});
```

### getInstance()

Returns a workflow instance by UUID, or `null` if not found.

```ts
async getInstance(uuid: string): Promise<WorkflowInstance | null>
```

**Example:**

```ts
const instance = await runtime.getInstance("a1b2c3d4-...");
if (instance) {
  console.log(instance.currentState); // "exportable"
  console.log(instance.context); // { paymentStatus: "paid" }
}
```

### getHistory()

Returns the transition history for a workflow instance.

```ts
async getHistory(
  workflowInstanceUuid: string,
  options?: { limit?: number; offset?: number },
): Promise<WorkflowHistoryRecord[]>
```

**Parameters:**

| Property               | Type     | Required | Description                            |
| ---------------------- | -------- | -------- | -------------------------------------- |
| `workflowInstanceUuid` | `string` | Yes      | The instance to query                  |
| `options.limit`        | `number` | No       | Maximum number of records to return    |
| `options.offset`       | `number` | No       | Number of records to skip (pagination) |

**Example:**

```ts
const history = await runtime.getHistory(instance.uuid, { limit: 50 });
for (const record of history) {
  console.log(`${record.fromState} → ${record.toState} via ${record.eventName}`);
}
```

### getHandle()

Returns a `WorkflowHandle` -- a thin proxy that binds the instance UUID and delegates all operations to the runtime. The handle caches nothing; every method is a fresh call.

```ts
getHandle(uuid: string): WorkflowHandle
```

This method is **synchronous** -- it does not hit the database. It simply creates a `WorkflowHandle` that holds the UUID and a reference to the runtime.

**Example:**

```ts
const handle = runtime.getHandle(instance.uuid);
// Now use the handle instead of passing the UUID everywhere
```

See [WorkflowHandle](#workflowhandle) below for the full API.

## WorkflowHandle

A lightweight proxy that binds a workflow instance UUID and delegates all operations to the runtime. Inspired by Temporal's workflow handle pattern.

The handle is the recommended way to interact with an existing workflow instance. It eliminates UUID repetition and provides a discoverable API.

```ts
import { WorkflowHandle } from "@duraflows/core";
```

**Key properties:**

- **No cached state** -- every method call hits the persistence layer
- **Synchronous creation** -- `getHandle()` does not query the database
- **Safe to pass around** -- the handle is just a UUID + a runtime reference

### API

| Method                              | Returns                             | Description                           |
| ----------------------------------- | ----------------------------------- | ------------------------------------- |
| `getInstance()`                     | `Promise<WorkflowInstance \| null>` | Get the current instance data         |
| `triggerEvent(eventName, options?)` | `Promise<WorkflowExecutionResult>`  | Trigger an event on the instance      |
| `getAvailableEvents()`              | `Promise<AvailableWorkflowEvent[]>` | Get events available in current state |
| `getHistory(options?)`              | `Promise<WorkflowHistoryRecord[]>`  | Get transition history                |

**`triggerEvent` options:**

| Property          | Type                      | Required | Description                          |
| ----------------- | ------------------------- | -------- | ------------------------------------ |
| `subject`         | `unknown`                 | No       | Domain entity passed to commands     |
| `triggerMetadata` | `Record<string, unknown>` | No       | Metadata about who/what triggered it |

### Example

```ts
// Create an instance, then get a handle
const instance = await runtime.createInstance({
  workflowName: "order",
  metadata: { orderId: "ORD-123" },
});
const handle = runtime.getHandle(instance.uuid);

// Read current state
const current = await handle.getInstance();
console.log(current?.currentState); // "new"

// Check what events are available
const events = await handle.getAvailableEvents();
console.log(events.map((e) => e.eventName)); // ["PaymentReceived", "Cancel"]

// Trigger an event
const result = await handle.triggerEvent("PaymentReceived", {
  subject: orderEntity,
  triggerMetadata: { source: "webhook" },
});
console.log(result.toState); // "exportable"

// View history
const history = await handle.getHistory({ limit: 10 });
```

## WorkflowValidator

Validates a workflow definition for structural correctness.

```ts
import { WorkflowValidator } from "@duraflows/core";

const validator = new WorkflowValidator();
const result = validator.validate(definition);

if (!result.valid) {
  for (const error of result.errors) {
    console.error(`${error.path}: ${error.message}`);
  }
}
```

### validate()

```ts
validate(definition: WorkflowDefinition, options?: WorkflowValidationOptions): ValidationResult
```

**WorkflowValidationOptions:**

| Property            | Type          | Description                                                                         |
| ------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `knownCommandNames` | `Set<string>` | If provided, validates that all command name references in events exist in this set |

**Returns:**

```ts
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  path: string; // e.g. "states.new.events.Export.targetState"
  message: string; // e.g. 'Target state "unknown" does not exist in states'
}
```

## WorkflowCompiler

Compiles a `WorkflowDefinition` into a finita `Process` with `CallbackCondition` guards.

```ts
import { WorkflowCompiler } from "@duraflows/core";

const compiler = new WorkflowCompiler();
const compiled = compiler.compile(definition);
// compiled.process is a finita ProcessInterface
// compiled.definition is the original definition
```

### compile()

```ts
compile(definition: WorkflowDefinition): CompiledWorkflow
```

**Compilation strategy:**

- Creates a finita `State` for each workflow state
- For each event with a `targetState`: creates a success transition guarded by `context.get("workflow:eventOutcome") === "success"`
- For each event with an `errorState`: creates a failure transition guarded by `context.get("workflow:eventOutcome") === "failure"`
- Caches compiled processes by definition name. Uses a JSON hash of the definition to detect changes — if the same name is recompiled with a different definition, the cache is invalidated and a fresh compilation is performed

**Returns:**

```ts
interface CompiledWorkflow {
  definition: WorkflowDefinition;
  process: ProcessInterface; // finita Process
}
```

## CommandExecutor

Executes commands sequentially with a fail-fast policy.

```ts
import { CommandExecutor } from "@duraflows/core";

const executor = new CommandExecutor(commandRegistry);
const result = await executor.execute(commands, subject, context);
```

### Constructor

```ts
new CommandExecutor(commandRegistry: WorkflowCommandRegistry)
```

### execute()

```ts
async execute(
  commands: WorkflowCommandRef[],
  subject: unknown,
  context: WorkflowExecutionContext,
): Promise<CommandExecutionResult>
```

**Behavior:**

1. If `commands` is empty, returns `{ outcome: "success", commandResults: [] }`
2. For each command in order:
   - Resolves the handler from `commandRegistry.get(name)`
   - Calls `command.execute(subject, context)`
   - If the command throws and `command.bestEffort === true`, catches the exception and records `{ ok: false, code: "BEST_EFFORT_THROWN", ... }` — chain continues
   - If `result.ok === false` and `command.bestEffort === true`, records the result and continues — chain is not stopped
   - If `result.ok === false` and the command is not best-effort, stops immediately (remaining commands are skipped)
   - If the command throws and is not best-effort, the exception propagates (not caught)

**Returns:**

```ts
interface CommandExecutionResult {
  outcome: "success" | "failure";
  commandResults: CommandResult[];
}
```

## OnEnterExecutor

Processes onEnter auto-transition chains. Given a starting state, it checks for `onEnter` definitions and follows the chain until reaching a state without `onEnter` (or hitting the depth limit).

```ts
import { OnEnterExecutor } from "@duraflows/core";

const executor = new OnEnterExecutor(commandExecutor);
const result = await executor.executeChain(definition, startingState, instanceUuid, subject, context, maxDepth);
```

### Constructor

```ts
new OnEnterExecutor(commandExecutor: CommandExecutor)
```

### executeChain()

```ts
async executeChain(
  definition: WorkflowDefinition,
  startingState: string,
  instanceUuid: string,
  subject: unknown,
  context: WorkflowExecutionContext,
  maxDepth: number,
): Promise<OnEnterChainResult>
```

**Behavior:**

1. Checks if the current state has an `onEnter` definition -- if not, returns immediately
2. Executes commands via `CommandExecutor` (fail-fast, same pattern as events)
3. On success + `targetState`: records hop, transitions. On failure + `errorState`: records hop, transitions. On failure + no `errorState`: throws `CommandFailureError`. On success + no `targetState`: records hop (commands ran as side effects), stops.
4. Increments depth counter, throws `OnEnterDepthExceededError` if exceeded
5. Repeats from step 1 with the new state

The `context` object is shared by reference -- command mutations accumulate across hops.

**Returns:**

```ts
interface OnEnterChainResult {
  finalState: string;
  outcome: "success" | "failure"; // "failure" if ANY hop routed to errorState, else "success"
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

`OnEnterChainResult.outcome` is `"failure"` if any hop routed to `errorState`, otherwise `"success"`. Prefer inspecting `outcome` directly rather than examining the last hop or last command result.

## EventExecutor

Orchestrates the full event lifecycle: validation, command execution, and finita state transition.

```ts
import { EventExecutor } from "@duraflows/core";

const eventExecutor = new EventExecutor(commandExecutor);
const result = await eventExecutor.execute(compiled, currentState, eventName, instanceUuid, subject, context);
```

### Constructor

```ts
new EventExecutor(commandExecutor: CommandExecutor)
```

### execute()

```ts
async execute(
  compiledWorkflow: CompiledWorkflow,
  currentState: string,
  eventName: string,
  instanceUuid: string,
  subject: unknown,
  context: WorkflowExecutionContext,
): Promise<EventExecutionResult>
```

**Behavior:**

1. Validates the event exists on the current state
2. Executes commands via `CommandExecutor`
3. If failure and no `errorState`, throws `CommandFailureError`
4. Sets `workflow:eventOutcome` on finita context
5. Creates a finita `Statemachine` from the compiled process at the current state
6. Calls `statemachine.triggerEvent()`
7. Returns the resulting state

**Returns:**

```ts
interface EventExecutionResult {
  outcome: "success" | "failure";
  fromState: string;
  toState: string;
  commandResults: CommandResult[];
}
```

## TimeoutResolver

Computes timeout deadlines and finds timeout event names.

```ts
import { TimeoutResolver } from "@duraflows/core";

const resolver = new TimeoutResolver();
```

### computeDeadline()

```ts
computeDeadline(definition: WorkflowDefinition, stateName: string, now: Date): Date | null
```

Returns the deadline `Date` for the timeout event on the given state, or `null` if no timeout event exists.

**Duration calculation:** Sums all defined fields:

```
totalMs = (afterMinutes * 60000) + (afterHours * 3600000) + (afterDays * 86400000)
deadline = new Date(now.getTime() + totalMs)
```

### getTimeoutEventName()

```ts
getTimeoutEventName(definition: WorkflowDefinition, stateName: string): string | null
```

Returns the name of the event that has a `timeout` definition on the given state, or `null`.

## toMermaidDiagram

Generates a [Mermaid](https://mermaid.js.org/) flowchart diagram from a workflow definition. The output visualizes states, events, error paths, timeouts, onEnter auto-transitions, and optionally command names.

```ts
import { toMermaidDiagram } from "@duraflows/core";
```

### Signature

```ts
function toMermaidDiagram(definition: WorkflowDefinition, options?: MermaidDiagramOptions): string;
```

### MermaidDiagramOptions

| Option         | Type           | Default | Description                                 |
| -------------- | -------------- | ------- | ------------------------------------------- |
| `showCommands` | `boolean`      | `false` | Show command names on event nodes           |
| `direction`    | `"TB" \| "LR"` | `"TB"`  | Diagram direction: top-bottom or left-right |

### Visual encoding

- **States** are rendered as rectangles with bold text and a light grey background
- **Events** are rendered as stadium (rounded) nodes between the source state and target state
- **Success paths** (event → targetState) use green arrows
- **Error paths** (event → errorState) use red dashed arrows
- **Timeouts** show a hourglass emoji with the duration (e.g., `⧖14d`)
- **onEnter** auto-transitions are rendered as `🗲` nodes
- **Terminal states** (no outbound events or onEnter targets) connect to an end node

### Examples

```ts
// Default — clean overview
const diagram = toMermaidDiagram(orderWorkflow);

// Show command names
const detailed = toMermaidDiagram(orderWorkflow, { showCommands: true });

// Left-to-right layout
const horizontal = toMermaidDiagram(orderWorkflow, { direction: "LR" });
```

The returned string is valid Mermaid `flowchart` syntax. Paste it into any Mermaid-compatible renderer (GitHub markdown, mermaid.live, Docusaurus, etc.).

## WorkflowCommand Interface

Command handlers implement this interface:

```ts
interface WorkflowCommand<TSubject = unknown> {
  readonly bestEffort?: boolean;
  execute(subject: TSubject, context: WorkflowExecutionContext): Promise<CommandResult> | CommandResult;
}
```

### bestEffort

When `bestEffort` is `true` the command is treated as a fire-and-forget side effect. Failure semantics differ from mandatory commands:

- If the command returns `{ ok: false, ... }`, the result is recorded but the chain continues as if the command had succeeded.
- If the command throws, the runtime catches the exception and converts it to a `CommandResult`:
  ```ts
  { ok: false, code: "BEST_EFFORT_THROWN", message, error: { name, message, stack? } }
  ```
  The chain continues. The `error` field is a serializable shape (not the raw thrown value) — safe to persist via `JSON.stringify`.
- A best-effort `ok: false` result does **not** taint `outcome` — `outcome` remains `"success"` unless a mandatory command fails.

Non-best-effort commands retain the current behavior: `ok: false` stops the chain (or routes to `errorState`); throws propagate.

**Example:**

```ts
class EmitMetricsCommand implements WorkflowCommand {
  readonly bestEffort = true;

  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    try {
      await metrics.increment("transition", { to: ctx.toState });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "METRICS_DOWN", error };
    }
  }
}
```

### CommandResult

```ts
interface CommandResult {
  ok: boolean;
  code?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
}
```

| Property   | Type                      | Description                                                                      |
| ---------- | ------------------------- | -------------------------------------------------------------------------------- |
| `ok`       | `boolean`                 | `true` if the command succeeded, `false` if it failed                            |
| `code`     | `string`                  | Machine-readable result code (e.g., `"PAYMENT_CHARGED"`, `"INSUFFICIENT_FUNDS"`) |
| `message`  | `string`                  | Human-readable description                                                       |
| `metadata` | `Record<string, unknown>` | Additional command-specific data                                                 |
| `error`    | `unknown`                 | Error details (for failures)                                                     |

### WorkflowExecutionContext

Passed to every command during execution. Provides access to the workflow's mutable context and immutable metadata.

```ts
interface WorkflowExecutionContext {
  triggerMetadata: Readonly<Record<string, unknown>>;
  now: Date;
  context: Record<string, unknown>;
  metadata: Readonly<Record<string, unknown>>;
  readonly commandMetadata: Readonly<Record<string, unknown>>;
  readonly fromState: string | null;
  readonly toState: string;
  readonly transitionUuid: string;
}
```

| Property          | Type                                | Description                                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triggerMetadata` | `Readonly<Record<string, unknown>>` | Optional metadata about who/what triggered the event (frozen object)                                                                                                                                                                                                                        |
| `now`             | `Date`                              | Current timestamp from the injected clock                                                                                                                                                                                                                                                   |
| `context`         | `Record<string, unknown>`           | **Mutable.** The workflow's working memory. Commands can read and write. Changes are persisted after the transition.                                                                                                                                                                        |
| `metadata`        | `Readonly<Record<string, unknown>>` | **Read-only.** The workflow's immutable identity labels set at creation. Attempting to write will be ignored (frozen object).                                                                                                                                                               |
| `commandMetadata` | `Readonly<Record<string, unknown>>` | **Read-only.** A deep-cloned, deep-frozen copy of the `metadata` field from the `WorkflowCommandRef` that invoked this command. `{}` when the ref defines no metadata. Each command in a chain sees its own metadata, not a prior command's.                                                |
| `fromState`       | `string \| null`                    | The state the workflow is leaving. `null` when entering the initial state on create.                                                                                                                                                                                                        |
| `toState`         | `string`                            | The state being entered for this command's execution. May differ from the eventual final state in an onEnter chain.                                                                                                                                                                         |
| `transitionUuid`  | `string`                            | UUID identifying this state entry. All commands running on entry to a given state (event commands + onEnter commands for that hop) share the same UUID. A fresh UUID is generated when the chain transitions to a new state. The matching observer `StateEnterEvent` carries the same UUID. |

See [Context and Metadata](./workflow-definitions.md#context-and-metadata) for a full explanation of the difference.

### Example Command

```ts
class ChargePaymentCommand implements WorkflowCommand<Order> {
  constructor(private readonly paymentGateway: PaymentGateway) {}

  async execute(subject: Order, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    // Read immutable metadata
    const customerId = ctx.metadata.customerId as string;

    try {
      const charge = await this.paymentGateway.charge({
        amount: subject.total,
        currency: subject.currency,
        customerId,
      });

      // Write to mutable context — persisted after transition
      ctx.context.chargeId = charge.id;
      ctx.context.chargedAt = ctx.now.toISOString();

      return {
        ok: true,
        code: "CHARGED",
        metadata: { chargeId: charge.id },
      };
    } catch (err) {
      // Track retry count in context
      const retryCount = (ctx.context.paymentRetries as number) ?? 0;
      ctx.context.paymentRetries = retryCount + 1;

      return {
        ok: false,
        code: "PAYMENT_FAILED",
        message: err instanceof Error ? err.message : String(err),
        error: err,
      };
    }
  }
}
```

## Registries

### WorkflowDefinitionRegistry

The shared interface exposes read-only access. Registration is on the concrete class only.

```ts
interface WorkflowDefinitionRegistry {
  get(workflowName: string): WorkflowDefinition;
  has(workflowName: string): boolean;
  getAll(): WorkflowDefinition[];
}
```

**InMemoryDefinitionRegistry** is the built-in implementation. It accepts an optional `WorkflowValidator` and `WorkflowCompiler` as constructor dependencies. When provided, `register()` validates and pre-compiles the definition eagerly -- so invalid definitions fail at startup, not at runtime. You can also pass `validationOptions` (e.g., `knownCommandNames`) to enable command name cross-validation.

```ts
import { InMemoryDefinitionRegistry, WorkflowValidator, WorkflowCompiler } from "@duraflows/core";

const registry = new InMemoryDefinitionRegistry({
  validator: new WorkflowValidator(),
  compiler: new WorkflowCompiler(),
  // Optional: cross-validate command references against known names
  // validationOptions: { knownCommandNames: new Set(["chargePayment", "sendEmail"]) },
});

// register() is on the concrete class, not the interface
registry.register(orderWorkflow); // validates + compiles immediately
registry.register(ticketWorkflow);

const def = registry.get("order"); // returns the definition
registry.has("order"); // true
registry.getAll(); // [orderWorkflow, ticketWorkflow]
```

Throws `WorkflowDefinitionError` on duplicate registration, validation failure, or unknown lookup.

### WorkflowCommandRegistry

The shared interface exposes read-only access. Registration is on the concrete class only.

```ts
interface WorkflowCommandRegistry {
  get(name: string): WorkflowCommand;
  has(name: string): boolean;
}
```

**InMemoryCommandRegistry** is the built-in implementation. Throws `WorkflowError` on duplicate registration or unknown lookup.

```ts
import { InMemoryCommandRegistry } from "@duraflows/core";

const registry = new InMemoryCommandRegistry();
// register() is on the concrete class, not the interface
registry.register("chargePayment", new ChargePaymentCommand(gateway));
registry.register("sendEmail", new SendEmailCommand(mailer));

const cmd = registry.get("chargePayment"); // returns the command instance
```

## WorkflowClock

```ts
interface WorkflowClock {
  now(): Date;
}
```

The clock is used for all timestamps (creation, transitions, timeout deadlines). Inject a custom clock for deterministic testing:

```ts
let currentTime = new Date("2025-01-01T00:00:00Z");

const testClock: WorkflowClock = {
  now: () => currentTime,
};

const runtime = new WorkflowRuntime({
  // ...
  clock: testClock,
});

// Advance time for testing
currentTime = new Date("2025-01-15T00:00:00Z");
```

## Observers

Observers receive a notification every time the runtime enters a new state. They are intended for cross-cutting concerns — audit logging, metrics, cache invalidation — that must not affect runtime correctness.

Both types are exported from `@duraflows/core`.

### Types

```ts
interface WorkflowObserver {
  readonly name: string;
  onEnter?(event: StateEnterEvent): void | Promise<void>;
}

interface StateEnterEvent {
  readonly workflowName: string;
  readonly instanceUuid: string;
  readonly state: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly transitionUuid: string;
  readonly triggerEvent: string | null;
  readonly context: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly triggerMetadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}
```

### Registration

Pass observers at construction time via `WorkflowRuntimeOptions.observers`, or register them dynamically with `runtime.addObserver()`:

```ts
const auditObserver: WorkflowObserver = {
  name: "audit-trail",
  onEnter: async (event) => {
    await auditLog.record({
      instance: event.instanceUuid,
      state: event.state,
      at: event.occurredAt,
      transitionUuid: event.transitionUuid,
    });
  },
};

const runtime = new WorkflowRuntime({
  // ... other config ...
  observers: [auditObserver],
});

// Or register dynamically:
runtime.addObserver(auditObserver);
```

### Firing semantics

- Observers fire **post-commit** — only after the state-entering transaction has committed successfully.
- Observers fire **sequentially** in registration order.
- Each state entry fires observers **at-most-once**. If the process crashes between commit and the observer call, the event is skipped (no outbox pattern; at-least-once delivery is deferred to a future version).
- If an observer's `onEnter` throws, the error is caught and logged via `console.warn`. Other observers still fire. Observer errors do **not** cause rollback or affect runtime correctness.

### Snapshot guarantees

`context`, `metadata`, and `triggerMetadata` on the event are deep-cloned via `structuredClone` and deep-frozen at event time. Consumers may hold references to these objects indefinitely — mutations to the live instance after the event fires do not affect the snapshot.

`transitionUuid` on the event matches the `transitionUuid` on the `WorkflowExecutionContext` seen by commands that ran during that state entry, making it straightforward to correlate command results with observer events.
