# @duraflows/nestjs

[NestJS](https://nestjs.com/) module for [duraflows](https://github.com/camcima/duraflows), providing dependency injection, services, and optional REST controllers for the durable workflow runtime.

Part of the [duraflows](https://github.com/camcima/duraflows) monorepo.

## Features

- Dynamic NestJS module with `forRoot()` and `forRootAsync()` configuration
- Registered as a **global module** -- feature modules can inject `WorkflowService` without re-importing `WorkflowModule.forRoot()`
- `WorkflowService` for creating instances, triggering events, and querying state
- Type-safe `createInstanceFor()` / `triggerEventFor()` variants that narrow `currentState` / `fromState` / `toState` to the state union of a `WorkflowDefinition<TState>`
- `WorkflowTimeoutService` for processing expired workflows
- Optional REST controllers for full HTTP API
- `@WorkflowCommand` decorator with automatic discovery
- `guards` option for registering declarative event preconditions
- Re-exports all types from `@duraflows/core` for convenience

## Installation

```bash
pnpm add @duraflows/core @duraflows/nestjs
```

> **Note:** `@duraflows/core` is a peer dependency — you install it alongside this
> package so your app and the adapter share a single core instance. `@nestjs/common`,
> `@nestjs/core`, `reflect-metadata`, and `rxjs` are peers too, but any NestJS app
> already has them, so no extra install is normally needed.

You will also need a persistence adapter such as [`@duraflows/pg`](https://www.npmjs.com/package/@duraflows/pg):

```bash
pnpm add @duraflows/pg pg
```

## Quick Start

### Module Registration

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
        { name: "sendToWarehouse", useClass: SendToWarehouseCommand },
        { name: "notifyCustomer", useClass: NotifyCustomerCommand },
      ],
      persistence: pgWorkflowProviders(pool),
      enableControllers: true, // optional REST endpoints
    }),
  ],
})
export class AppModule {}
```

### Async Configuration

```ts
WorkflowModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    workflows: [orderWorkflow],
    commands: [{ name: "sendToWarehouse", useClass: SendToWarehouseCommand }],
    persistence: pgWorkflowProviders(new Pool({ connectionString: config.get("DATABASE_URL") })),
  }),
  inject: [ConfigService],
});
```

### Using WorkflowService

```ts
import { Injectable } from "@nestjs/common";
import { WorkflowService } from "@duraflows/nestjs";

@Injectable()
export class OrderService {
  constructor(private readonly workflowService: WorkflowService) {}

  async createOrder(orderData: CreateOrderDto) {
    const instance = await this.workflowService.createInstance({
      workflowName: "order",
      metadata: { orderId: orderData.id },
    });
    return instance;
  }

  async receivePayment(instanceUuid: string, order: Order) {
    const handle = this.workflowService.getHandle(instanceUuid);
    return handle.triggerEvent("PaymentReceived", { subject: order });
  }

  async getAvailableActions(instanceUuid: string) {
    const handle = this.workflowService.getHandle(instanceUuid);
    return handle.getAvailableEvents();
  }
}
```

### Type-Safe Variants

When you have a typed `WorkflowDefinition<TState>` in hand, use `createInstanceFor` / `triggerEventFor` to narrow `currentState`, `fromState`, and `toState` to the state union instead of `string`:

```ts
import type { WorkflowDefinition } from "@duraflows/nestjs";

type OrderState = "new" | "paid" | "shipped" | "cancelled";

const orderWorkflow: WorkflowDefinition<OrderState> = {
  name: "order",
  initialState: "new",
  states: {
    new: { events: { PaymentReceived: { targetState: "paid" }, Cancel: { targetState: "cancelled" } } },
    paid: { events: { Ship: { targetState: "shipped" } } },
    shipped: {},
    cancelled: {},
  },
};

// `instance.currentState` is typed as OrderState, not string
const instance = await workflowService.createInstanceFor(orderWorkflow, {
  metadata: { orderId: "abc" },
});

// `result.fromState` / `result.toState` are typed as OrderState
const result = await workflowService.triggerEventFor(orderWorkflow, {
  workflowInstanceUuid: instance.uuid,
  eventName: "PaymentReceived",
});
```

`triggerEventFor` does not verify at runtime that the instance belongs to the supplied definition -- the type narrowing is the caller's contract. Pair it with `createInstanceFor` to keep that invariant.

### @WorkflowCommand Decorator

Mark command handlers for automatic discovery:

```ts
import { WorkflowCommand as IWorkflowCommand, CommandResult, WorkflowExecutionContext } from "@duraflows/nestjs";
import { WorkflowCommand } from "@duraflows/nestjs";

@WorkflowCommand("sendToWarehouse")
export class SendToWarehouseCommand implements IWorkflowCommand {
  constructor(private readonly warehouseClient: WarehouseClient) {} // NestJS DI works here

  async execute(subject: unknown, ctx: WorkflowExecutionContext): Promise<CommandResult> {
    await this.warehouseClient.ship(ctx.metadata.orderId as string);
    return { ok: true, code: "SHIPPED" };
  }
}
```

## REST Controllers

When `enableControllers: true` is set, the following endpoints are registered:

> **Security:** the generated controllers ship **without authentication**. They expose instance creation, arbitrary event triggering, full history reads, and `POST /workflows/timeouts/process` (an administrative bulk operation). Apply your own auth guards and rate limiting before enabling them in production — e.g. a global `APP_GUARD`, or guards bound per controller. Note also that `triggerEvent` responses include each command's `CommandResult` verbatim, so command authors must not place sensitive data in `CommandResult.error` / `message` if the controllers are enabled.

| Controller                   | Endpoints                              |
| ---------------------------- | -------------------------------------- |
| `WorkflowInstanceController` | Create and retrieve workflow instances |
| `WorkflowEventController`    | Trigger events on instances            |
| `WorkflowQueryController`    | Query available events and history     |
| `WorkflowTimeoutController`  | Process expired workflows              |

## Documentation

See the full documentation in the [duraflows repository](https://github.com/camcima/duraflows).

## License

MIT
