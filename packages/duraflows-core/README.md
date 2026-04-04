# @duraflows/core

Framework-agnostic durable workflow runtime for TypeScript, built on top of [@camcima/finita](https://github.com/camcima/finita).

Part of the [duraflows](https://github.com/camcima/duraflows) monorepo.

## Features

- Declarative workflow definitions in plain TypeScript objects
- Named states with event-triggered transitions
- Sequential command execution with success/failure branching
- Timeout-driven transitions with persisted deadlines
- Mutable context accessible to commands, with state-defined patches merged on entry
- Immutable metadata for identity labels that never change after creation
- Full audit history of every transition with command results
- Persistence-agnostic -- bring your own database adapter
- Mermaid diagram generation from workflow definitions

## Installation

```bash
npm install @duraflows/core
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

- `WorkflowInstanceStore`
- `WorkflowHistoryStore`
- `WorkflowTransactionRunner`

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT
