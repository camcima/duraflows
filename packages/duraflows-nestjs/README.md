# @duraflows/nestjs

[NestJS](https://nestjs.com/) module for [duraflows](https://github.com/camcima/duraflows), providing dependency injection, services, and optional REST controllers for the durable workflow runtime.

Part of the [duraflows](https://github.com/camcima/duraflows) monorepo.

## Features

- Dynamic NestJS module with `forRoot()` and `forRootAsync()` configuration
- `WorkflowService` for creating instances, triggering events, and querying state
- `WorkflowTimeoutService` for processing expired workflows
- Optional REST controllers for full HTTP API
- `@WorkflowCommand` decorator with automatic discovery
- Re-exports all types from `@duraflows/core` for convenience

## Installation

```bash
pnpm add @duraflows/core @duraflows/nestjs
```

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
