---
name: duraflows-tester
description: "Provides testing patterns for duraflows workflows. Use when writing tests for WorkflowDefinition objects, WorkflowCommand handlers, workflow lifecycle, timeout processing, onEnter chains, or any code that imports from @duraflows/core, @duraflows/pg, or @duraflows/nestjs in test files."
---

# duraflows Testing Guide

Testing patterns for duraflows workflows using Vitest. Covers clock injection, in-memory stores, command mocking, timeout simulation, and assertion patterns.

---

## Test Framework

duraflows uses **Vitest** with global test APIs (`describe`, `it`, `expect`, `vi`).

```ts
import { describe, it, expect, beforeEach } from "vitest";
```

---

## In-Memory Test Doubles

Use these in-memory implementations instead of PostgreSQL for unit and integration tests. Define them locally in your test file or in a shared test helper.

> **For adapter authors:** if you're testing a custom `WorkflowInstanceStore` implementation (Prisma, Drizzle, TypeORM, Kysely, etc.), use the v1.0.0 conformance suite instead — see [Adapter Conformance](#adapter-conformance-v100). It exercises the persistence contract more thoroughly than the doubles below.

### InMemoryInstanceStore

```ts
import type { WorkflowInstanceStore, WorkflowInstance } from "@duraflows/core";

class InMemoryInstanceStore implements WorkflowInstanceStore {
  private readonly instances = new Map<string, WorkflowInstance>();

  async create(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.uuid, structuredClone(instance));
  }

  async findByUuid(uuid: string): Promise<WorkflowInstance | null> {
    const inst = this.instances.get(uuid);
    return inst ? structuredClone(inst) : null;
  }

  async lockByUuid(uuid: string): Promise<WorkflowInstance | null> {
    return this.findByUuid(uuid); // no real locking needed in memory
  }

  async update(instance: WorkflowInstance): Promise<void> {
    this.instances.set(instance.uuid, structuredClone(instance));
  }

  async findExpired(limit: number, now: Date): Promise<WorkflowInstance[]> {
    const results: WorkflowInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.expiresAt && inst.expiresAt <= now) {
        results.push(structuredClone(inst));
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}
```

**Important**: Use `structuredClone()` in all methods to prevent shared references between test code and store.

### InMemoryHistoryStore

```ts
import { randomUUID } from "node:crypto";
import type { WorkflowHistoryStore, WorkflowHistoryRecord } from "@duraflows/core";

class InMemoryHistoryStore implements WorkflowHistoryStore {
  private readonly records: Array<WorkflowHistoryRecord & { uuid: string }> = [];

  async append(entry: WorkflowHistoryRecord): Promise<string> {
    const uuid = randomUUID();
    this.records.push({ ...entry, uuid });
    return uuid;
  }

  async findByInstanceUuid(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    const matching = this.records.filter((r) => r.workflowInstanceUuid === workflowInstanceUuid);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? matching.length;
    return matching.slice(offset, offset + limit);
  }
}
```

### InMemoryTransactionRunner

```ts
import type { WorkflowTransactionRunner } from "@duraflows/core";

class InMemoryTransactionRunner implements WorkflowTransactionRunner {
  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    return callback(); // simple pass-through
  }
}
```

---

## Clock Injection

Always inject a fixed clock for deterministic tests.

### Fixed Clock

```ts
import type { WorkflowClock } from "@duraflows/core";

const fixedDate = new Date("2025-06-15T12:00:00.000Z");
const clock: WorkflowClock = { now: () => fixedDate };
```

### Advanceable Clock

```ts
let currentTime = new Date("2025-06-15T12:00:00.000Z");
const clock: WorkflowClock = { now: () => currentTime };

// Later in tests:
currentTime = new Date("2025-06-16T12:00:00.000Z"); // advance 24 hours
```

---

## Runtime Setup for Tests

```ts
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  WorkflowValidator,
  WorkflowCompiler,
} from "@duraflows/core";

let runtime: WorkflowRuntime;
let instanceStore: InMemoryInstanceStore;
let historyStore: InMemoryHistoryStore;
let commandRegistry: InMemoryCommandRegistry;

beforeEach(() => {
  instanceStore = new InMemoryInstanceStore();
  historyStore = new InMemoryHistoryStore();

  const definitionRegistry = new InMemoryDefinitionRegistry({
    validator: new WorkflowValidator(),
    compiler: new WorkflowCompiler(),
  });
  definitionRegistry.register(myWorkflowDefinition);

  commandRegistry = new InMemoryCommandRegistry();
  // Register commands (see Command Mocking section)

  runtime = new WorkflowRuntime({
    definitionRegistry,
    commandRegistry,
    instanceStore,
    historyStore,
    transactionRunner: new InMemoryTransactionRunner(),
    clock: { now: () => new Date("2025-06-15T12:00:00.000Z") },
  });
});
```

---

## Command Mocking

### Helper Functions

```ts
import type { WorkflowCommand, CommandResult } from "@duraflows/core";

function successCommand(overrides: Partial<CommandResult> = {}): WorkflowCommand {
  return {
    execute: async () => ({ ok: true, ...overrides }),
  };
}

function failureCommand(overrides: Partial<CommandResult> = {}): WorkflowCommand {
  return {
    execute: async () => ({
      ok: false,
      code: "FAIL",
      message: "command failed",
      ...overrides,
    }),
  };
}
```

### Context-Mutating Commands

```ts
const enrichCommand: WorkflowCommand = {
  execute: async (_subject, ctx) => {
    ctx.context.enriched = true;
    ctx.context.enrichedAt = ctx.now.toISOString();
    return { ok: true, code: "ENRICHED" };
  },
};
```

### Best-Effort Commands (v1.0.0)

```ts
function bestEffortFailureCommand(): WorkflowCommand {
  return {
    bestEffort: true,
    execute: async () => ({ ok: false, code: "PROVIDER_DOWN" }),
  };
}

function bestEffortThrowCommand(): WorkflowCommand {
  return {
    bestEffort: true,
    execute: async () => {
      throw new Error("flaky vendor");
    },
  };
}
```

### Commands Reading commandMetadata (v1.0.0)

```ts
const notifyCommand: WorkflowCommand = {
  execute: async (_subject, ctx) => {
    const channel = ctx.commandMetadata.channel as string;
    const template = ctx.commandMetadata.template as string;
    return {
      ok: true,
      code: "NOTIFIED",
      metadata: { channel, template, transitionUuid: ctx.transitionUuid },
    };
  },
};
```

### Mock Registry Factory

```ts
function makeRegistry(commands: Record<string, WorkflowCommand>): WorkflowCommandRegistry {
  return {
    get(name: string) {
      const cmd = commands[name];
      if (!cmd) throw new Error(`Command "${name}" not found`);
      return cmd;
    },
    has(name: string) {
      return name in commands;
    },
  };
}
```

### Registration

```ts
commandRegistry.register("validateOrder", successCommand());
commandRegistry.register("chargePayment", failureCommand({ code: "INSUFFICIENT_FUNDS" }));
commandRegistry.register("enrichData", enrichCommand);
```

---

## Testing Patterns

### Full Lifecycle Test

```ts
it("completes a workflow from creation to terminal state", async () => {
  const instance = await runtime.createInstance({
    workflowName: "order",
    metadata: { orderId: "ORD-001" },
  });
  expect(instance.currentState).toBe("new");

  const result = await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "PaymentReceived",
    subject: { amount: 100 },
    triggerMetadata: { source: "test" },
  });

  expect(result.outcome).toBe("success");
  expect(result.fromState).toBe("new");
  expect(result.toState).toBe("exportable");
});
```

### Testing with WorkflowHandle

```ts
it("uses handle for sequential operations", async () => {
  const instance = await runtime.createInstance({ workflowName: "order" });
  const handle = runtime.getHandle(instance.uuid);

  await handle.triggerEvent("PaymentReceived");

  const current = await handle.getInstance();
  expect(current?.currentState).toBe("exportable");

  const events = await handle.getAvailableEvents();
  expect(events.map((e) => e.eventName)).toContain("Export");
});
```

### Testing Command Failures with errorState

```ts
it("transitions to errorState when command fails", async () => {
  commandRegistry.register("chargePayment", failureCommand({ code: "DECLINED" }));

  const result = await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "ChargePayment",
  });

  expect(result.outcome).toBe("failure");
  expect(result.toState).toBe("payment_failed");
});
```

### Testing bestEffort Commands (v1.0.0)

A `bestEffort: true` command's failure must NOT taint `outcome` or stop the chain. Pin this behavior:

```ts
it("bestEffort returned ok:false does not taint outcome", async () => {
  commandRegistry.register("notify", bestEffortFailureCommand());
  commandRegistry.register("settle", successCommand({ code: "SETTLED" }));
  // Workflow event runs commands in order: [notify (bestEffort), settle]

  const result = await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Finalize",
  });

  expect(result.outcome).toBe("success"); // bestEffort failure ignored
  expect(result.toState).toBe("finalized");
  expect(result.commandResults[0].ok).toBe(false); // notify failure recorded
  expect(result.commandResults[1].ok).toBe(true); // settle still ran
});

it("bestEffort thrown error is captured as BEST_EFFORT_THROWN", async () => {
  commandRegistry.register("notify", bestEffortThrowCommand());

  const result = await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Finalize",
  });

  expect(result.outcome).toBe("success");
  const notifyResult = result.commandResults[0];
  expect(notifyResult.ok).toBe(false);
  expect(notifyResult.code).toBe("BEST_EFFORT_THROWN");
  // The error field is a serializable shape — safe for JSON persistence
  expect(notifyResult.error).toMatchObject({
    name: "Error",
    message: "flaky vendor",
  });
});
```

### Testing Command Failures without errorState

```ts
import { CommandFailureError } from "@duraflows/core";

it("throws CommandFailureError when no errorState defined", async () => {
  commandRegistry.register("riskyAction", failureCommand());

  await expect(
    runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "DoRiskyThing",
    }),
  ).rejects.toThrow(CommandFailureError);
});
```

### Testing Invalid Events

```ts
import { InvalidEventError } from "@duraflows/core";

it("throws InvalidEventError for unavailable event", async () => {
  // Instance is in "new" state, "Ship" is not available there
  await expect(
    runtime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "Ship",
    }),
  ).rejects.toThrow(InvalidEventError);
});
```

### Testing Context Mutations

```ts
it("commands can write to context", async () => {
  commandRegistry.register("enrich", {
    execute: async (_subject, ctx) => {
      ctx.context.processed = true;
      ctx.context.processedAt = ctx.now.toISOString();
      return { ok: true };
    },
  });

  await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Process",
  });

  const updated = await instanceStore.findByUuid(instance.uuid);
  expect(updated?.context.processed).toBe(true);
  expect(updated?.context.processedAt).toBe("2025-06-15T12:00:00.000Z");
});
```

### Testing Context Merge Order

```ts
it("state context wins over command writes for same key", async () => {
  // Command writes status = "processing"
  commandRegistry.register("process", {
    execute: async (_subject, ctx) => {
      ctx.context.status = "processing";
      return { ok: true };
    },
  });

  // But target state defines status: "completed"
  // State context merges on top -> final value is "completed"
  await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Process",
  });

  const updated = await instanceStore.findByUuid(instance.uuid);
  expect(updated?.context.status).toBe("completed");
});
```

### Testing Metadata Immutability

```ts
it("metadata is frozen during command execution", async () => {
  commandRegistry.register("check", {
    execute: async (_subject, ctx) => {
      expect(Object.isFrozen(ctx.metadata)).toBe(true);
      expect(() => {
        (ctx.metadata as Record<string, unknown>).injected = "value";
      }).toThrow();
      return { ok: true };
    },
  });

  await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Check",
  });
});
```

---

## Testing Timeouts

Use an advanceable clock to simulate time passing. The runtime sets `expiresAt` automatically when an instance enters a state with a timeout event, using the injected clock. Advance the clock past that point, then call `processExpiredWorkflows()`.

### Advanceable Clock Pattern (Recommended)

```ts
it("processes expired workflows after timeout elapses", async () => {
  // 1. Set up runtime with advanceable clock
  let currentTime = new Date("2025-06-15T12:00:00.000Z");
  const clock = { now: () => currentTime };
  const runtime = new WorkflowRuntime({
    definitionRegistry,
    commandRegistry,
    instanceStore,
    historyStore,
    transactionRunner: new InMemoryTransactionRunner(),
    clock,
  });

  // 2. Create instance — enters a state with a 2-hour timeout
  const instance = await runtime.createInstance({ workflowName: "order" });
  // Runtime automatically sets expiresAt = clock.now() + 2 hours

  // 3. Advance clock past the timeout
  currentTime = new Date("2025-06-15T14:01:00.000Z"); // 2h 1m later

  // 4. Process expired workflows — clock.now() is used for the comparison
  const result = await runtime.processExpiredWorkflows();
  expect(result.processed).toBe(1);
  expect(result.failed).toHaveLength(0);

  // 5. Verify state transition
  const updated = await instanceStore.findByUuid(instance.uuid);
  expect(updated?.currentState).toBe("escalated"); // timeout target state
});
```

### Verifying Timeout Trigger Metadata

```ts
it("timeout events have source: timeout in triggerMetadata", async () => {
  // ... setup and process expired ...

  const history = await historyStore.findByInstanceUuid(instance.uuid);
  const timeoutRecord = history.find((h) => h.eventName === "AutoClose");
  expect(timeoutRecord?.triggerMetadata?.source).toBe("timeout");
});
```

---

## Testing onEnter Chains

### Single onEnter Hop

```ts
it("auto-transitions via onEnter", async () => {
  // Triggering "Submit" transitions to "validating" which has onEnter -> "validated"
  const result = await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Submit",
  });

  // Returns the FINAL state, not the intermediate
  expect(result.toState).toBe("validated");
});
```

### Verifying onEnter History Records

```ts
it("records onEnter hops in history", async () => {
  await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Submit",
  });

  const history = await historyStore.findByInstanceUuid(instance.uuid);
  expect(history).toHaveLength(2);

  // First record: the triggered event
  expect(history[0].eventName).toBe("Submit");
  expect(history[0].toState).toBe("validating");

  // Second record: the onEnter auto-transition
  expect(history[1].eventName).toBe("onEnter");
  expect(history[1].toState).toBe("validated");
  expect(history[1].triggerMetadata?.source).toBe("onEnter");
});
```

### Asserting OnEnter Chain outcome (v1.0.0)

`OnEnterChainResult.outcome` aggregates across hops: it is `"failure"` if any hop routed to `errorState`, otherwise `"success"`. Prefer asserting on `outcome` over inspecting the last hop or last command result. The aggregate is also surfaced on the `WorkflowExecutionResult.outcome` returned from `triggerEvent`:

```ts
it("aggregates outcome across event + onEnter chain", async () => {
  // Event succeeds, but onEnter hop routes to errorState — outcome must be "failure"
  const result = await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Submit",
  });
  expect(result.outcome).toBe("failure");
  expect(result.toState).toBe("validation_failed");
});
```

### Testing onEnter Depth Limit

```ts
import { OnEnterDepthExceededError } from "@duraflows/core";

it("throws OnEnterDepthExceededError when chain is too deep", async () => {
  const limitedRuntime = new WorkflowRuntime({
    // ... same setup but:
    maxOnEnterDepth: 2,
  });

  // Workflow with 3+ onEnter hops will exceed limit
  await expect(
    limitedRuntime.triggerEvent({
      workflowInstanceUuid: instance.uuid,
      eventName: "Start",
    }),
  ).rejects.toThrow(OnEnterDepthExceededError);
});
```

---

## Testing Observers (v1.0.0)

Observers fire **post-commit, at-most-once, sequentially, error-contained**. Test them with a recording-observer fixture that captures every `StateEnterEvent`.

### Recording Observer

```ts
import type { WorkflowObserver, StateEnterEvent } from "@duraflows/core";

function recordingObserver(name = "test"): WorkflowObserver & { events: StateEnterEvent[] } {
  const events: StateEnterEvent[] = [];
  return {
    name,
    events,
    onEnter: (event) => {
      events.push(event);
    },
  };
}
```

Pass it via `WorkflowRuntimeOptions.observers`:

```ts
const observer = recordingObserver();
runtime = new WorkflowRuntime({
  /* ... */
  observers: [observer],
});
```

### Observer Fires on Every State Entry

```ts
it("fires observer on createInstance and triggerEvent", async () => {
  const observer = recordingObserver();
  // ... wire observer into runtime ...

  const instance = await runtime.createInstance({ workflowName: "order" });
  await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

  expect(observer.events).toHaveLength(2);
  expect(observer.events[0]).toMatchObject({
    fromState: null, // initial entry
    toState: "new",
    triggerEvent: null,
  });
  expect(observer.events[1]).toMatchObject({
    fromState: "new",
    toState: "submitted",
    triggerEvent: "Submit",
  });
});
```

### Observer transitionUuid Matches Command Context

This is the v1.0.0 correlation guarantee: the `transitionUuid` an observer sees on `event.transitionUuid` is the same UUID the commands that ran on entry to that state saw on `ctx.transitionUuid`.

```ts
it("transitionUuid correlates command context with observer event", async () => {
  let commandTransitionUuid: string | undefined;
  commandRegistry.register("recordUuid", {
    execute: async (_subject, ctx) => {
      commandTransitionUuid = ctx.transitionUuid;
      return { ok: true };
    },
  });

  const observer = recordingObserver();
  // ... wire observer into runtime ...

  await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

  const matchingEvent = observer.events.find((e) => e.toState === "submitted");
  expect(matchingEvent?.transitionUuid).toBe(commandTransitionUuid);
});
```

### Observer Errors Don't Affect the Workflow

```ts
import type { ObserverErrorHandler } from "@duraflows/core";

it("observer throw is contained and routed to onObserverError", async () => {
  const errors: Array<{ name: string; message: string }> = [];
  const onObserverError: ObserverErrorHandler = (error, observer) => {
    errors.push({
      name: observer.name,
      message: error instanceof Error ? error.message : String(error),
    });
  };

  const throwingObserver: WorkflowObserver = {
    name: "throws",
    onEnter: () => {
      throw new Error("boom");
    },
  };

  runtime = new WorkflowRuntime({
    /* ... */
    observers: [throwingObserver],
    onObserverError,
  });

  // Workflow still completes successfully
  const result = await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "Submit",
  });
  expect(result.outcome).toBe("success");

  // Observer error was captured, not propagated
  expect(errors).toEqual([{ name: "throws", message: "boom" }]);
});
```

### Observers and Command-Only Events

A command-only event (no `targetState`) DOES fire the observer — as a self-transition with `fromState === toState`. Test for this if your observer behavior depends on it:

```ts
it("command-only events fire observer with fromState === toState", async () => {
  // Workflow has a `note_added` event in `pending` with no targetState
  await runtime.triggerEvent({
    workflowInstanceUuid: instance.uuid,
    eventName: "note_added",
    subject: { note: "test" },
  });

  const last = observer.events[observer.events.length - 1];
  expect(last.fromState).toBe("pending");
  expect(last.toState).toBe("pending");
  expect(last.triggerEvent).toBe("note_added");
});
```

---

## Adapter Conformance (v1.0.0)

For custom `WorkflowInstanceStore` implementations (Prisma, Drizzle, TypeORM, Kysely, etc.), use the shared conformance suite from `@duraflows/core/testing`:

```ts
import { describe } from "vitest";
import { runInstanceStoreConformance } from "@duraflows/core/testing";
import { MyInstanceStore } from "../src/my-instance-store.js";
import { MyTransactionRunner } from "../src/my-transaction-runner.js";

describe("MyInstanceStore (conformance)", () => {
  runInstanceStoreConformance({
    setup: async () => {
      // Construct your store + transaction runner against a real (or in-memory) database
      const store = new MyInstanceStore(db);
      const transactionRunner = new MyTransactionRunner(db);
      return {
        store,
        transactionRunner,
        teardown: async () => {
          await db.destroy();
        },
      };
    },
  });
});
```

The suite verifies:

- `lockByUuid` acquires a row-level lock and throws if called outside a transaction
- `update` enforces optimistic concurrency on `version` and throws `WorkflowError` on mismatch
- `update` does NOT modify `metadata` (write-once after `create`)
- `findExpired` honors limit + ordering and skips already-locked rows
- Nested-transaction reuse via `transactionRunner.runInTransaction`

A passing run is the contract guarantee that your adapter works with the runtime. `@duraflows/pg` and `@duraflows/kysely` both run it in CI.

---

## Testing NestJS Integration

### Module Compilation

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { WorkflowModule, WorkflowService } from "@duraflows/nestjs";

describe("WorkflowModule", () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [myWorkflow],
          persistence: {
            instanceStore: new InMemoryInstanceStore(),
            historyStore: new InMemoryHistoryStore(),
            transactionRunner: new InMemoryTransactionRunner(),
          },
        }),
      ],
    }).compile();
  });

  it("provides WorkflowService", () => {
    const service = moduleRef.get(WorkflowService);
    expect(service).toBeDefined();
  });
});
```

---

## Testing PostgreSQL Stores (Unit)

Mock the `pg` Pool and PoolClient:

```ts
import { vi } from "vitest";

function createMockPool(queryResult = { rows: [] }) {
  return { query: vi.fn().mockResolvedValue(queryResult) } as unknown as Pool;
}

it("inserts instance with correct SQL", async () => {
  const pool = createMockPool();
  const store = new PgWorkflowInstanceStore(pool);

  await store.create(sampleInstance);

  const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(sql).toContain("INSERT INTO workflow_instances");
  expect(params[0]).toBe(sampleInstance.uuid);
});
```

---

## History Assertion Patterns

```ts
const history = await historyStore.findByInstanceUuid(instance.uuid);

// Assert record count
expect(history).toHaveLength(3);

// Assert individual record
expect(history[0]).toMatchObject({
  fromState: "new",
  eventName: "PaymentReceived",
  toState: "exportable",
  outcome: "success",
});

// Assert command results within a record
expect(history[0].commandResults).toHaveLength(2);
expect(history[0].commandResults[0].ok).toBe(true);
expect(history[0].commandResults[0].code).toBe("CHARGED");

// Assert trigger metadata
expect(history[0].triggerMetadata?.actor).toBe("user-123");
```
