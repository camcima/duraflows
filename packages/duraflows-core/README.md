# @duraflows/core

Framework-agnostic durable workflow runtime for TypeScript, built on top of [@camcima/finita](https://github.com/camcima/finita).

Part of the [duraflows](https://github.com/camcima/duraflows) monorepo.

## Features

- Declarative workflow definitions in plain TypeScript objects, optionally generic over a `TState` union for end-to-end state type safety (`WorkflowDefinition<TState>`, `WorkflowInstance<TState>`, `WorkflowExecutionResult<TState>`)
- Named states with event-triggered transitions
- Sequential command execution with success/failure branching
- Timeout-driven transitions with persisted deadlines; a timeout that keeps failing is retried with exponential backoff and then parked until re-armed
- Mutable context accessible to commands, with state-defined patches merged on entry
- Immutable metadata for identity labels that never change after creation
- Full audit history of every transition with command results
- Persistence-agnostic -- bring your own database adapter
- **Event guards** — declarative preconditions that block transitions without running commands; rejections surface as `outcome: "guard-rejected"` and are recorded in history.
- Observers notified after commit on every state entry
- Definition versioning: a content change without a `version` bump is rejected, and in-flight instances stay pinned to the version they started on (or opt into `versionPolicy: "latest"`)
- `migrateInstances()` to move instances between stored definition versions in batches, with state mapping, a context transform and a dry run
- Mermaid diagram generation from workflow definitions

## Installation

```bash
pnpm add @duraflows/core
```

## Quick Example

### Define a Workflow

```ts
import type { WorkflowDefinition } from "@duraflows/core";

const orderWorkflow: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: {
      context: { paymentStatus: "pending" },
      events: {
        PaymentReceived: { targetState: "paid" },
        Cancel: { targetState: "cancelled" },
      },
    },
    paid: {
      context: { paymentStatus: "paid" },
      events: {
        Ship: {
          targetState: "shipped",
          errorState: "ship_failed",
          commands: [{ name: "sendToWarehouse" }],
        },
      },
    },
    shipped: {},
    cancelled: {},
    ship_failed: {},
  },
};
```

### Implement Command Handlers

```ts
import type { WorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/core";

class SendToWarehouseCommand implements WorkflowCommand {
  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    const orderId = ctx.metadata.orderId as string;
    try {
      await warehouseApi.createShipment(orderId);
      return { ok: true, code: "SHIPPED" };
    } catch (err) {
      return { ok: false, code: "WH_ERROR", message: String(err) };
    }
  }
}
```

### Wire It Up

```ts
import { WorkflowRuntime, InMemoryDefinitionRegistry, InMemoryCommandRegistry } from "@duraflows/core";

const definitionRegistry = new InMemoryDefinitionRegistry();
definitionRegistry.register(orderWorkflow);

const commandRegistry = new InMemoryCommandRegistry();
commandRegistry.register("sendToWarehouse", new SendToWarehouseCommand());

const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  instanceStore, // implements WorkflowInstanceStore
  historyStore, // implements WorkflowHistoryStore
  transactionRunner, // implements WorkflowTransactionRunner
  clock: { now: () => new Date() },
});
await runtime.initialize(); // surfaces definition/version errors at boot

const instance = await runtime.createInstance({ workflowName: "order" });

// Get a handle — binds the UUID, no DB call
const handle = runtime.getHandle(instance.uuid);

// All operations go through the handle
const result = await handle.triggerEvent("PaymentReceived", { subject: orderEntity });
const events = await handle.getAvailableEvents();
const current = await handle.getInstance();
const history = await handle.getHistory();
```

## Persistence Adapters

The core package defines the persistence interfaces. Use one of the official adapters or build your own:

| Package                                                                | Description                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`@duraflows/pg`](https://www.npmjs.com/package/@duraflows/pg)         | PostgreSQL adapter using `pg`                                  |
| [`@duraflows/kysely`](https://www.npmjs.com/package/@duraflows/kysely) | PostgreSQL adapter using Kysely (supports shared transactions) |
| [`@duraflows/nestjs`](https://www.npmjs.com/package/@duraflows/nestjs) | NestJS module with DI, services, and optional REST controllers |

To build a custom adapter, implement these interfaces:

- `WorkflowInstanceStore` -- including `countInstances()`, required since 7.0.0, and the optional `findInstanceUuids()` (7.1.0), which lets `migrateInstances()` find candidates on its own and since 7.2.0 receives `states`/`excludeStates` as hints a store may honor or ignore
- `WorkflowHistoryStore`
- `WorkflowTransactionRunner`

Optionally implement `WorkflowDefinitionStore` too, to enable definition versioning.

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT

## Event idempotency

Provide optional `WorkflowIdempotencyStore` and pass a stable `idempotencyKey` to `triggerEvent` or a handle. Keys identify one occurrence per instance; duplicates replay the committed result. An optional `idempotencyFingerprint` detects conflicting business inputs. Unkeyed calls retain existing behavior. See [the guide](../../docs/event-idempotency.md) for the transaction contract, outcome semantics, and limits.

## Optional durable command progress

The runtime adds `enqueueEvent`, `processPendingExecutions`, `getExecution`, `retryExecution` and `cancelExecution`; the existing synchronous API keeps its transaction semantics. See [Durable command progress](https://github.com/camcima/duraflows/blob/main/docs/durable-execution.md) for setup, worker polling, downstream idempotency, rollout and recovery limits.
