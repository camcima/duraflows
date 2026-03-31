<div align="center">

<picture>
  <img alt="duraflows" src="assets/logo.svg" width="520">
</picture>

<br>

[![Test](https://github.com/camcima/duraflows/actions/workflows/test.yml/badge.svg)](https://github.com/camcima/duraflows/actions/workflows/test.yml)
[![Validate](https://github.com/camcima/duraflows/actions/workflows/validate.yml/badge.svg)](https://github.com/camcima/duraflows/actions/workflows/validate.yml)
[![codecov](https://codecov.io/gh/camcima/duraflows/graph/badge.svg)](https://codecov.io/gh/camcima/duraflows)
[![npm version](https://img.shields.io/npm/v/@duraflows/core)](https://www.npmjs.com/package/@duraflows/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%20%7C%2020%20%7C%2022-green.svg)](https://nodejs.org/)

</div>

A durable workflow runtime for TypeScript built on top of [@camcima/finita](https://github.com/camcima/finita). Supports named states, event-triggered transitions, sequential command execution with success/failure branching, timeout-driven transitions, mutable workflow context, and full audit history.

Designed as a family of three packages:

| Package             | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `@duraflows/core`   | Framework-agnostic runtime, types, and persistence interfaces              |
| `@duraflows/pg`     | PostgreSQL persistence adapter using `pg`                                  |
| `@duraflows/nestjs` | NestJS module integration with DI, services, and optional REST controllers |

## Key Features

- **Declarative workflow definitions** in plain TypeScript objects
- **Command execution** with sequential fail-fast policy and success/failure branching
- **Timeout processing** with persisted deadlines and batch processing
- **Mutable context** accessible to commands, with state-defined patches merged on entry
- **Immutable metadata** for identity labels that never change after creation
- **Full audit history** of every transition with command results
- **Row-level locking** for concurrent access safety
- **Persistence-agnostic core** -- bring your own database library (pg, Prisma, Drizzle, TypeORM)
- **NestJS integration** with dependency injection, services, and optional REST controllers
- **Mermaid diagram generation** from workflow definitions with customizable options

## Installation

```bash
# Core runtime (always required)
npm install @duraflows/core

# PostgreSQL adapter (if using pg)
npm install @duraflows/pg pg

# NestJS integration (if using NestJS)
npm install @duraflows/nestjs
```

## Quick Example

### Define a Workflow

```mermaid
flowchart TB

    classDef stateNode fill:#f1f5f9,stroke:#64748b,stroke-width:2px,color:#1e293b,font-size:20px

    _start@{ shape: sm-circ }
    new["<b>new</b>"]:::stateNode
    exportable["<b>exportable</b>"]:::stateNode
    exported["<b>exported</b>"]:::stateNode
    delivered["<b>delivered</b>"]:::stateNode
    closed["<b>closed</b>"]:::stateNode
    cancelled["<b>cancelled</b>"]:::stateNode
    export_failed["<b>export_failed</b>"]:::stateNode
    _end@{ shape: framed-circle }

    _start --> new

    new__PaymentReceived(["PaymentReceived"])
    new --> new__PaymentReceived
    new__PaymentReceived --> exportable
    new__Cancel(["Cancel"])
    new --> new__Cancel
    new__Cancel --> cancelled

    exportable__Export(["Export"])
    exportable --> exportable__Export
    exportable__Export --> exported
    exportable__Export --> export_failed

    exported__Deliver(["Deliver"])
    exported --> exported__Deliver
    exported__Deliver --> delivered

    delivered__TimeOut(["TimeOut fa:fa-hourglass 14d"])
    delivered --> delivered__TimeOut
    delivered__TimeOut --> closed

    export_failed__RetryExport(["RetryExport"])
    export_failed --> export_failed__RetryExport
    export_failed__RetryExport --> exportable

    closed --> _end
    cancelled --> _end

    linkStyle 0,1,3,5,8,10,12,14,15 stroke-width:3px
    linkStyle 2,4,6,9,11,13 stroke:#22c55e,stroke-width:3px
    linkStyle 7 stroke:#dc3545,stroke-width:3px,stroke-dasharray:5
```

> **Tip:** This diagram was generated with `toMermaidDiagram(orderWorkflow)` from `@duraflows/core`. See [Diagram Generation](#diagram-generation) below.

```ts
import type { WorkflowDefinition } from "@duraflows/core";

const orderWorkflow: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: {
      context: { paymentStatus: "pending", isActive: true },
      events: {
        PaymentReceived: {
          targetState: "exportable",
        },
        Cancel: {
          targetState: "cancelled",
        },
      },
    },
    exportable: {
      context: { paymentStatus: "paid" },
      events: {
        Export: {
          targetState: "exported",
          errorState: "export_failed",
          commands: [{ name: "sendOrderToWarehouse" }, { name: "notifyCustomer" }],
        },
      },
    },
    exported: {
      context: { shipmentStatus: "shipped" },
      events: {
        Deliver: { targetState: "delivered" },
      },
    },
    delivered: {
      context: { shipmentStatus: "delivered", isActive: false },
      events: {
        TimeOut: {
          targetState: "closed",
          timeout: { afterDays: 14 },
        },
      },
    },
    closed: {},
    cancelled: {
      context: { isActive: false },
    },
    export_failed: {
      events: {
        RetryExport: {
          targetState: "exportable",
        },
      },
    },
  },
};
```

### Implement Command Handlers

```ts
import type { WorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/core";

class SendOrderToWarehouseCommand implements WorkflowCommand {
  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    // Read immutable metadata
    const orderId = ctx.metadata.orderId as string;

    try {
      const shipment = await warehouseApi.createShipment(subject);

      // Write to mutable context — persisted after transition
      ctx.context.shipmentId = shipment.id;
      ctx.context.shippedAt = ctx.now.toISOString();

      return { ok: true, code: "SHIPPED" };
    } catch (err) {
      return { ok: false, code: "WH_ERROR", message: String(err) };
    }
  }
}
```

### Use with NestJS

```ts
import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { WorkflowModule } from "@duraflows/nestjs";
import { pgWorkflowProviders } from "@duraflows/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

@Module({
  imports: [
    WorkflowModule.forRoot({
      workflows: [orderWorkflow],
      commands: [
        { name: "sendOrderToWarehouse", useClass: SendOrderToWarehouseCommand },
        { name: "notifyCustomer", useClass: NotifyCustomerCommand },
      ],
      persistence: pgWorkflowProviders(pool),
      enableControllers: true, // optional REST endpoints
    }),
  ],
})
export class AppModule {}
```

```ts
import { Injectable } from "@nestjs/common";
import { WorkflowService } from "@duraflows/nestjs";

@Injectable()
export class OrderService {
  constructor(private readonly workflowService: WorkflowService) {}

  async createOrder(orderData: CreateOrderDto) {
    const order = await this.orderRepo.create(orderData);

    const instance = await this.workflowService.createInstance({
      workflowName: "order",
      metadata: { orderId: order.uuid },
    });

    return { order, workflowInstanceUuid: instance.uuid };
  }

  async receivePayment(workflowInstanceUuid: string, order: Order) {
    // Get a handle — binds the UUID, no DB call
    const handle = this.workflowService.getHandle(workflowInstanceUuid);

    const result = await handle.triggerEvent("PaymentReceived", {
      subject: order,
      triggerMetadata: { source: "user", actor: order.customerUuid },
    });

    console.log(result.outcome); // "success"
    console.log(result.toState); // "exportable"

    // All operations go through the handle — no UUID repetition
    const events = await handle.getAvailableEvents();
    const history = await handle.getHistory({ limit: 10 });
  }
}
```

### Use Without NestJS

```ts
import { WorkflowRuntime, InMemoryDefinitionRegistry, InMemoryCommandRegistry } from "@duraflows/core";
import { pgWorkflowProviders } from "@duraflows/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = pgWorkflowProviders(pool);

const definitionRegistry = new InMemoryDefinitionRegistry();
definitionRegistry.register(orderWorkflow);

const commandRegistry = new InMemoryCommandRegistry();
commandRegistry.register("sendOrderToWarehouse", new SendOrderToWarehouseCommand());
commandRegistry.register("notifyCustomer", new NotifyCustomerCommand());

const runtime = new WorkflowRuntime({
  definitionRegistry,
  commandRegistry,
  ...persistence,
  clock: { now: () => new Date() },
});

// Create an instance
const instance = await runtime.createInstance({
  workflowName: "order",
});

// Get a handle — binds the UUID, no DB call
const handle = runtime.getHandle(instance.uuid);

// Trigger an event through the handle
const result = await handle.triggerEvent("PaymentReceived", {
  subject: orderEntity,
});

// All operations go through the handle
const events = await handle.getAvailableEvents();
const current = await handle.getInstance();
const history = await handle.getHistory();
```

## Diagram Generation

Generate Mermaid diagrams from any workflow definition:

```ts
import { toMermaidDiagram } from "@duraflows/core";

// Default options — clean overview
const diagram = toMermaidDiagram(orderWorkflow);

// Show command names and use left-to-right layout
const detailed = toMermaidDiagram(orderWorkflow, {
  showCommands: true,
  direction: "LR",
});
```

**Options:**

| Option         | Default | Description                                      |
| -------------- | ------- | ------------------------------------------------ |
| `showCommands` | `false` | Show command names on event nodes                |
| `direction`    | `"TB"`  | Diagram direction: `"TB"` (top-bottom) or `"LR"` |

The output is valid Mermaid `flowchart` syntax. Paste it into any Mermaid renderer (GitHub markdown, mermaid.live, documentation tools) to visualize your workflow.

## Database Setup

The `@duraflows/pg` package provides two ways to set up the database schema:

### Option 1: Copy the reference migration

A ready-made dbmate migration is shipped at:

```
node_modules/@duraflows/pg/sql/dbmate/001_workflow_core.sql
```

Copy it into your migration directory. It uses `gen_random_uuid()` (PostgreSQL 13+) for history record UUIDs.

### Option 2: Generate a migration with `generateMigrationSql()`

Use this to choose between `gen_random_uuid()` (PG 13+) and `uuidv7()` (PG 18+, time-ordered):

```ts
import { generateMigrationSql } from "@duraflows/pg";

// For PostgreSQL 18+ (time-ordered UUIDs)
const { up, down } = generateMigrationSql({ uuidStrategy: "uuidv7" });

// For PostgreSQL 13-17 (random UUIDs, the default)
const { up, down } = generateMigrationSql();
```

Paste the `up` and `down` SQL into your migration file.

Both options create two tables: `workflow_instances` and `workflow_history`.

## Custom Persistence Adapters

The NestJS module and the core runtime are fully decoupled from `pg`. To use Prisma, Drizzle, TypeORM, or any other library, implement three interfaces from `@duraflows/core`:

- `WorkflowInstanceStore`
- `WorkflowHistoryStore`
- `WorkflowTransactionRunner`

See the [Persistence Guide](docs/persistence.md) for details and examples.

## Documentation

| Document                                             | Description                                              |
| ---------------------------------------------------- | -------------------------------------------------------- |
| [Getting Started](docs/getting-started.md)           | Installation, database setup, first workflow             |
| [Workflow Definitions](docs/workflow-definitions.md) | States, events, commands, timeouts, context and metadata |
| [Core Runtime API](docs/core-runtime.md)             | WorkflowRuntime, compiler, validator, executors, diagram |
| [Persistence](docs/persistence.md)                   | Interfaces, pg adapter, custom adapters                  |
| [NestJS Integration](docs/nestjs-integration.md)     | Module, services, controllers, DI tokens                 |
| [Error Handling](docs/error-handling.md)             | Error types, when they occur, how to handle them         |

## AI Agent Skills

If you use AI coding agents (Claude Code, Cursor, Copilot, etc.), install the [duraflows agent skills](https://github.com/camcima/duraflows-skills) to give your agent domain knowledge about duraflows APIs, patterns, and best practices:

```bash
npx skills add camcima/duraflows-skills
```

This installs 5 skills that automatically activate when the agent detects duraflows-related code or workflow-building requests:

| Skill                           | Description                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| `duraflows-developer`           | API patterns, deterministic guardrails, and anti-patterns              |
| `duraflows-builder`             | Translates natural-language requirements into workflow implementations |
| `duraflows-tester`              | Testing patterns: clock injection, in-memory stores, command mocking   |
| `duraflows-persistence-adapter` | Guide for implementing custom persistence adapters                     |
| `duraflows-reviewer`            | Code review checklist for workflow definitions and commands            |

## Architecture

```mermaid
graph TD
    App[Application Code] --> NestJS["@duraflows/nestjs<br/>(NestJS adapter)"]
    App --> Core["@duraflows/core<br/>(runtime + types)"]
    NestJS --> Core
    PG["@duraflows/pg<br/>(PostgreSQL adapter)"] --> Core
    Custom["Your custom adapter<br/>(Prisma, Drizzle, etc.)"] -.-> Core
```

`duraflows-nestjs` depends only on `duraflows-core` interfaces. `duraflows-pg` is one persistence adapter. You can replace it with your own.

## License

MIT
