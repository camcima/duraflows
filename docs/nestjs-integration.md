# NestJS Integration

The `@duraflows/nestjs` package provides a NestJS module that wires the workflow runtime into dependency injection with services, optional REST controllers, and DI-backed command resolution.

## Installation

```bash
pnpm add @duraflows/nestjs @duraflows/core

# If using the built-in pg adapter:
pnpm add @duraflows/pg pg

# If using REST controllers (enableControllers: true):
pnpm add class-validator class-transformer
```

`@duraflows/nestjs` does **not** depend on `@duraflows/pg`. You choose your persistence adapter.

## @WorkflowCommand Decorator

The `@WorkflowCommand("name")` decorator auto-registers command handlers via NestJS discovery, eliminating the need to manually list them in the `commands` array.

```ts
import { WorkflowCommand } from "@duraflows/nestjs";
import type {
  WorkflowCommand as WorkflowCommandInterface,
  CommandResult,
  WorkflowExecutionContext,
} from "@duraflows/core";

@WorkflowCommand("chargePayment")
export class ChargePaymentCommand implements WorkflowCommandInterface {
  constructor(private readonly paymentGateway: PaymentGateway) {}

  async execute(subject: unknown, context: WorkflowExecutionContext): Promise<CommandResult> {
    // ...
    return { ok: true, code: "CHARGED" };
  }
}
```

The decorator:

- Applies `@Injectable()` automatically -- you do not need both decorators
- Associates the class with the command name string used in workflow definitions
- Is discovered at module initialization via NestJS `DiscoveryService`

To use decorated commands, add them to the `providers` array of your module (or any imported module):

```ts
@Module({
  imports: [
    WorkflowModule.forRoot({
      workflows: [orderWorkflow],
      persistence: pgWorkflowProviders(pool),
    }),
  ],
  providers: [ChargePaymentCommand, SendEmailCommand],
})
export class AppModule {}
```

No `commands` array needed -- the module discovers the decorated classes automatically.

### Mixed Mode

You can mix decorated and explicit commands. This is useful when some commands come from external modules where you can't add the decorator:

```ts
WorkflowModule.forRoot({
  workflows: [orderWorkflow],
  commands: [
    { name: "legacyExport", useClass: LegacyExportCommand },  // explicit
  ],
  persistence: pgWorkflowProviders(pool),
}),
```

If the same command name is registered both explicitly and via decorator, the module throws `WorkflowError` at startup to prevent ambiguity.

### Naming Note

The `@WorkflowCommand` decorator and the `WorkflowCommand` interface from core share the same name. Import the interface from `@duraflows/core` directly:

```ts
import { WorkflowCommand } from "@duraflows/nestjs"; // decorator
import type { WorkflowCommand as WorkflowCommandInterface } from "@duraflows/core"; // interface
```

## WorkflowModule

### forRoot()

Synchronous module configuration.

```ts
import { WorkflowModule } from "@duraflows/nestjs";

@Module({
  imports: [
    WorkflowModule.forRoot({
      workflows: [orderWorkflow, ticketWorkflow],
      commands: [
        { name: "chargePayment", useClass: ChargePaymentCommand },
        { name: "sendEmail", useClass: SendEmailCommand },
      ],
      persistence: pgWorkflowProviders(pool),
      clock: { now: () => new Date() }, // optional, defaults to real clock
      enableControllers: true, // optional, defaults to false
    }),
  ],
})
export class AppModule {}
```

**WorkflowModuleOptions:**

| Property            | Type                            | Required | Description                                                                             |
| ------------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `workflows`         | `WorkflowDefinition[]`          | Yes      | Workflow definitions to register                                                        |
| `commands`          | `WorkflowCommandRegistration[]` | No       | Explicit command handler registrations. Optional if using `@WorkflowCommand` decorator. |
| `observers`         | `WorkflowObserver[]`            | No       | Lifecycle observers registered with the runtime. See [Observers](#observers).           |
| `persistence`       | `WorkflowPersistenceProvider`   | Yes      | Persistence implementations (instance store, history store, transaction runner)         |
| `clock`             | `WorkflowClock`                 | No       | Custom clock. Defaults to `{ now: () => new Date() }`                                   |
| `enableControllers` | `boolean`                       | No       | If `true`, registers REST controllers. Defaults to `false`                              |

### forRootAsync()

Asynchronous module configuration for cases where options depend on other providers. The interface is split: `commands` and `enableControllers` are static fields on the options object (available at module-setup time), while `useFactory` returns the async-resolved config (`workflows`, `persistence`, `clock`, `observers`). Observers belong in `useFactory` so they can be composed from injected services.

```ts
@Module({
  imports: [
    WorkflowModule.forRootAsync({
      imports: [ConfigModule, AuditModule],
      commands: [{ name: "chargePayment", useClass: ChargePaymentCommand }],
      enableControllers: true,
      useFactory: (config: ConfigService, auditService: AuditService) => ({
        workflows: [orderWorkflow],
        persistence: pgWorkflowProviders(new Pool({ connectionString: config.get("DATABASE_URL") })),
        observers: [
          {
            name: "audit",
            onEnter: (event) => auditService.record(event),
          },
        ],
      }),
      inject: [ConfigService, AuditService],
    }),
  ],
})
export class AppModule {}
```

**WorkflowModuleAsyncOptions:**

| Property            | Type                                       | Required | Description                                                                                                        |
| ------------------- | ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `imports`           | `Type<unknown>[]`                          | No       | Modules to import (for injection)                                                                                  |
| `commands`          | `WorkflowCommandRegistration[]`            | No       | Explicit command handler registrations (static, not from factory). Optional if using `@WorkflowCommand` decorator. |
| `enableControllers` | `boolean`                                  | No       | If `true`, registers REST controllers. Defaults to `false` (static, not from factory)                              |
| `useFactory`        | `(...args) => WorkflowModuleFactoryConfig` | Yes      | Factory returning async-resolved config                                                                            |
| `inject`            | `InjectionToken[]`                         | No       | Tokens to inject into the factory                                                                                  |

**WorkflowModuleFactoryConfig** (returned by `useFactory`):

| Property      | Type                          | Required | Description                                                                          |
| ------------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `workflows`   | `WorkflowDefinition[]`        | Yes      | Workflow definitions to register                                                     |
| `persistence` | `WorkflowPersistenceProvider` | Yes      | Persistence implementations                                                          |
| `clock`       | `WorkflowClock`               | No       | Custom clock. Defaults to `{ now: () => new Date() }`                                |
| `observers`   | `WorkflowObserver[]`          | No       | Lifecycle observers. Return them from the factory to compose from injected services. |

#### Breaking change: observers moved into useFactory (v0.6.0)

In v0.6.0, `observers` was removed from the top-level `WorkflowModuleAsyncOptions` and must now be returned from `useFactory` as part of `WorkflowModuleFactoryConfig`. This allows observers to reference services from the DI container.

```ts
// BEFORE (v0.5.x) — no longer works
WorkflowModule.forRootAsync({
  observers: [myObserver], // removed from top-level
  useFactory: () => ({ workflows: [...], persistence: ... }),
});

// AFTER (v0.6.0+) — correct
WorkflowModule.forRootAsync({
  useFactory: (auditService: AuditService) => ({
    workflows: [...],
    persistence: ...,
    observers: [myObserver], // now part of factory return value
  }),
  inject: [AuditService],
});
```

**Migration:** move the `observers` array from the top level of `forRootAsync(...)` into the object returned by `useFactory`. No other changes are required. The synchronous `forRoot` is unaffected — it continues to accept `observers` as a top-level option.

## Observers

Observers receive lifecycle events fired by the workflow runtime after a state transition is committed. They are registered via the `observers` option on `WorkflowModuleOptions` (for `forRoot`) or returned from `useFactory` (for `forRootAsync`).

**Semantics:**

- Fired post-commit — the database write has already completed before observers run
- At-most-once — an observer that throws does not retry
- Sequential — observers run one after another in registration order
- Error-contained — a thrown error is logged via `console.warn` and does not affect workflow correctness or the transaction result

**`WorkflowObserver` interface:**

```ts
interface WorkflowObserver {
  name: string;
  onEnter?: (event: StateEnterEvent) => Promise<void> | void;
}
```

**`StateEnterEvent` fields:**

| Field            | Type     | Description                                         |
| ---------------- | -------- | --------------------------------------------------- |
| `transitionUuid` | `string` | UUID shared by all hops in a single event execution |
| `workflowName`   | `string` | Name of the workflow definition                     |
| `instanceUuid`   | `string` | UUID of the workflow instance                       |
| `fromState`      | `string` | State before the transition                         |
| `toState`        | `string` | State entered by this hop                           |
| `eventName`      | `string` | Event that triggered the transition                 |

**Example — forRoot:**

```typescript
@Module({
  imports: [
    WorkflowModule.forRoot({
      workflows: [myDefinition],
      persistence: myPersistenceProvider,
      observers: [
        {
          name: "audit",
          onEnter: async (event) => {
            // post-commit, at-most-once
            await auditLog.record(event);
          },
        },
      ],
    }),
  ],
})
export class AppModule {}
```

**Example — forRootAsync (observers from DI):**

```typescript
WorkflowModule.forRootAsync({
  useFactory: (auditService: AuditService) => ({
    workflows: [myDefinition],
    persistence: myPersistence,
    observers: [
      {
        name: "audit",
        onEnter: (event) => auditService.record(event),
      },
    ],
  }),
  inject: [AuditService],
});
```

## WorkflowCommandRegistration

Maps a command name to a NestJS-managed class. Used for explicit registration via the `commands` array. For most cases, prefer the [`@WorkflowCommand` decorator](#workflowcommand-decorator) instead.

```ts
interface WorkflowCommandRegistration {
  name: string;
  useClass: Type<WorkflowCommand>;
}
```

The class is registered as a NestJS provider and resolved from the DI container. This means your command handlers can inject other services:

```ts
@Injectable()
class ChargePaymentCommand implements WorkflowCommand<Order> {
  constructor(
    private readonly paymentGateway: PaymentGateway,
    private readonly logger: LoggerService,
  ) {}

  async execute(subject: Order, context: WorkflowExecutionContext): Promise<CommandResult> {
    this.logger.log(`Charging order ${subject.id}`);
    // ...
  }
}
```

## Services

### WorkflowService

The primary application-facing service. Inject it into your services/controllers:

```ts
import { Injectable } from "@nestjs/common";
import { WorkflowService } from "@duraflows/nestjs";

@Injectable()
export class OrderService {
  constructor(private readonly workflowService: WorkflowService) {}
}
```

**Methods:**

| Method                       | Parameters                    | Returns                             | Description                                |
| ---------------------------- | ----------------------------- | ----------------------------------- | ------------------------------------------ |
| `createInstance(input)`      | `CreateWorkflowInstanceInput` | `Promise<WorkflowInstance>`         | Create a new workflow instance             |
| `triggerEvent(input)`        | `TriggerWorkflowEventInput`   | `Promise<WorkflowExecutionResult>`  | Trigger an event on an instance            |
| `getAvailableEvents(input)`  | `GetAvailableEventsInput`     | `Promise<AvailableWorkflowEvent[]>` | Get events available for an instance       |
| `getInstance(uuid)`          | `string`                      | `Promise<WorkflowInstance \| null>` | Get instance by UUID                       |
| `getHistory(uuid, options?)` | `string, { limit?, offset? }` | `Promise<WorkflowHistoryRecord[]>`  | Get history for an instance                |
| `getHandle(uuid)`            | `string`                      | `WorkflowHandle`                    | Get a thin proxy handle (sync, no DB call) |

**Example using WorkflowHandle (recommended):**

```ts
@Injectable()
export class OrderService {
  constructor(private readonly workflowService: WorkflowService) {}

  private getWorkflowHandle(order: Order): WorkflowHandle {
    return this.workflowService.getHandle(order.workflowInstanceUuid);
  }

  async createOrder(data: CreateOrderDto) {
    const order = await this.orderRepo.create(data);

    const instance = await this.workflowService.createInstance({
      workflowName: "order",
      metadata: { orderId: order.uuid },
    });

    await this.orderRepo.setWorkflowInstanceUuid(order.uuid, instance.uuid);
    return order;
  }

  async processPayment(orderUuid: string) {
    const order = await this.orderRepo.findByUuid(orderUuid);
    const handle = this.getWorkflowHandle(order);

    return handle.triggerEvent("PaymentReceived", { subject: order });
  }

  async getOrderStatus(orderUuid: string) {
    const order = await this.orderRepo.findByUuid(orderUuid);
    const handle = this.getWorkflowHandle(order);

    const instance = await handle.getInstance();
    return instance?.currentState;
  }

  async getOrderHistory(orderUuid: string) {
    const order = await this.orderRepo.findByUuid(orderUuid);
    const handle = this.getWorkflowHandle(order);

    return handle.getHistory({ limit: 50, offset: 0 });
  }

  async getAvailableActions(orderUuid: string) {
    const order = await this.orderRepo.findByUuid(orderUuid);
    const handle = this.getWorkflowHandle(order);

    return handle.getAvailableEvents();
  }
}
```

### WorkflowTimeoutService

Processes expired workflow instances. Typically called from a scheduled task.

```ts
import { WorkflowTimeoutService } from "@duraflows/nestjs";
```

**Methods:**

| Method                            | Parameters          | Returns                                  | Description                                                |
| --------------------------------- | ------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `processExpiredWorkflows(limit?)` | `number` (optional) | `Promise<ProcessExpiredWorkflowsResult>` | Process expired instances. Returns `{ processed, failed }` |

**Example with @nestjs/schedule:**

```ts
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { WorkflowTimeoutService } from "@duraflows/nestjs";

@Injectable()
export class TimeoutScheduler {
  constructor(private readonly timeoutService: WorkflowTimeoutService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processTimeouts() {
    const result = await this.timeoutService.processExpiredWorkflows(100);
    if (result.processed > 0) {
      console.log(`Processed ${result.processed} expired workflows`);
    }
    if (result.failed.length > 0) {
      console.warn(`Failed: ${result.failed.map((f) => f.uuid).join(", ")}`);
    }
  }
}
```

## REST Controllers

When `enableControllers: true` is set, four controllers are registered. All controller inputs are validated with DTOs using `class-validator` and `ValidationPipe` (`transform: true`, `whitelist: true`).

### WorkflowInstanceController

**Create a workflow instance:**

```
POST /workflows
```

Request body:

```json
{
  "workflowName": "order",
  "metadata": { "orderId": "ORD-123" },
  "context": {}
}
```

Response: `WorkflowInstance`

```json
{
  "uuid": "a1b2c3d4-...",
  "workflowName": "order",
  "currentState": "new",
  "version": 0,
  "expiresAt": null,
  "lastTransitionAt": "2026-03-27T00:00:00.000Z",
  "context": {},
  "metadata": { "orderId": "ORD-123" },
  "createdAt": "2026-03-27T00:00:00.000Z",
  "updatedAt": "2026-03-27T00:00:00.000Z"
}
```

**Get a workflow instance by UUID:**

```
GET /workflows/:uuid
```

Response: `WorkflowInstance` (same shape as above). Returns `404` if not found.

### WorkflowEventController

**Trigger an event:**

```
POST /workflows/:workflowInstanceUuid/events/:eventName
```

Request body:

```json
{
  "triggerMetadata": {
    "source": "user",
    "actor": "550e8400-e29b-41d4-a716-446655440000"
  },
  "subject": { "orderId": "ORD-123" }
}
```

Response: `WorkflowExecutionResult`

```json
{
  "outcome": "success",
  "fromState": "new",
  "toState": "exportable",
  "commandResults": [],
  "historyUuid": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
}
```

### WorkflowQueryController

**Get available events:**

```
GET /workflows/:workflowInstanceUuid/events
```

Response: `AvailableWorkflowEvent[]`

```json
[
  {
    "eventName": "PaymentReceived",
    "targetState": "exportable",
    "hasCommands": false,
    "hasTimeout": false
  }
]
```

**Get history:**

```
GET /workflows/:workflowInstanceUuid/history?limit=50&offset=0
```

Response: `WorkflowHistoryRecord[]`

```json
[
  {
    "workflowInstanceUuid": "...",
    "fromState": "new",
    "eventName": "PaymentReceived",
    "toState": "exportable",
    "outcome": "success",
    "commandResultsJson": [],
    "triggerMetadata": { "source": "user", "actor": "..." }
  }
]
```

### WorkflowTimeoutController

**Process expired workflows:**

```
POST /workflows/timeouts/process?limit=100
```

Response:

```json
{
  "processed": 5,
  "failed": []
}
```

## Injection Tokens

For advanced use cases, you can inject individual components using their tokens:

```ts
import {
  WORKFLOW_RUNTIME,
  WORKFLOW_INSTANCE_STORE,
  WORKFLOW_HISTORY_STORE,
  WORKFLOW_COMMAND_REGISTRY,
  WORKFLOW_DEFINITION_REGISTRY,
  WORKFLOW_TRANSACTION_RUNNER,
  WORKFLOW_CLOCK,
} from "@duraflows/nestjs";
```

**Example:**

```ts
@Injectable()
export class CustomService {
  constructor(
    @Inject(WORKFLOW_INSTANCE_STORE)
    private readonly instanceStore: WorkflowInstanceStore,

    @Inject(WORKFLOW_DEFINITION_REGISTRY)
    private readonly definitionRegistry: WorkflowDefinitionRegistry,
  ) {}

  async getWorkflowDefinitions() {
    return this.definitionRegistry.getAll();
  }
}
```

## Re-exports

`@duraflows/nestjs` re-exports the entire `@duraflows/core` public API. You can import everything from a single package:

```ts
// Instead of:
import type { WorkflowDefinition } from "@duraflows/core";
import { WorkflowService } from "@duraflows/nestjs";

// You can do:
import type { WorkflowDefinition } from "@duraflows/nestjs";
import { WorkflowService } from "@duraflows/nestjs";
```

This includes the observer types. Both import paths are valid:

```ts
// Both are equivalent:
import type { WorkflowObserver, StateEnterEvent } from "@duraflows/nestjs";
import type { WorkflowObserver, StateEnterEvent } from "@duraflows/core";
```

## Startup Validation

The NestJS module validates all workflow definitions at startup using `WorkflowValidator` with `knownCommandNames`. This means:

- Any command name referenced in a workflow definition that does not have a registered implementation (neither via `@WorkflowCommand` decorator nor explicit `commands` array) will throw `WorkflowDefinitionError` at startup
- You get immediate feedback on misconfigured command mappings, rather than discovering them at runtime when an event is triggered

```ts
// This will throw WorkflowDefinitionError at module initialization
// because "nonExistentCommand" is not registered anywhere
WorkflowModule.forRoot({
  workflows: [
    {
      name: "broken",
      initialState: "start",
      states: {
        start: {
          events: {
            Go: { targetState: "done", commands: [{ name: "nonExistentCommand" }] },
          },
        },
        done: {},
      },
    },
  ],
  persistence: pgWorkflowProviders(pool),
});
```

## NestCommandRegistry

The NestJS module uses `NestCommandRegistry` to resolve command handlers from the DI container:

```ts
class NestCommandRegistry implements WorkflowCommandRegistry {
  constructor(moduleRef: ModuleRef, registrations: WorkflowCommandRegistration[]);
  get(name: string): WorkflowCommand;
  has(name: string): boolean;
}
```

This is an internal class. You interact with it through `WorkflowModuleOptions.commands` or the `@WorkflowCommand` decorator. The `WorkflowCommandRegistry` interface only exposes `get()` and `has()` -- registration happens at construction time from the merged command registrations (explicit + discovered).
