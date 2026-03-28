import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { Test } from "@nestjs/testing";
import { Injectable } from "@nestjs/common";
import {
  WorkflowModule,
  WorkflowCommand,
  WORKFLOW_COMMAND_REGISTRY,
  WORKFLOW_DEFINITION_REGISTRY,
} from "@camcima/duraflows-nestjs";
import {
  WorkflowError,
  WorkflowDefinitionError,
  type WorkflowCommand as WorkflowCommandInterface,
  type CommandResult,
  type WorkflowExecutionContext,
  type WorkflowDefinition,
  type WorkflowPersistenceProvider,
  type WorkflowClock,
  type WorkflowInstanceStore,
  type WorkflowHistoryStore,
  type WorkflowHistoryRecord,
  type WorkflowTransactionRunner,
  type WorkflowInstance,
  type WorkflowCommandRegistry,
  type WorkflowDefinitionRegistry as DefinitionRegistryType,
} from "@camcima/duraflows-core";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubInstanceStore: WorkflowInstanceStore = {
  async create(_instance: WorkflowInstance): Promise<void> {},
  async findByUuid(_uuid: string): Promise<WorkflowInstance | null> {
    return null;
  },
  async lockByUuid(_uuid: string): Promise<WorkflowInstance | null> {
    return null;
  },
  async update(_instance: WorkflowInstance): Promise<void> {},
  async findExpired(_limit: number, _now: Date): Promise<WorkflowInstance[]> {
    return [];
  },
};

const stubHistoryStore: WorkflowHistoryStore = {
  async append(_entry: WorkflowHistoryRecord): Promise<string> {
    return "history-uuid";
  },
  async findByInstanceUuid(
    _uuid: string,
    _options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    return [];
  },
};

const stubTransactionRunner: WorkflowTransactionRunner = {
  async runInTransaction<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  },
};

const fixedClock: WorkflowClock = { now: () => new Date("2026-01-15T12:00:00.000Z") };

const stubPersistence: WorkflowPersistenceProvider = {
  instanceStore: stubInstanceStore,
  historyStore: stubHistoryStore,
  transactionRunner: stubTransactionRunner,
};

// ---------------------------------------------------------------------------
// Decorated command classes
// ---------------------------------------------------------------------------

@WorkflowCommand("decorated-approve")
class DecoratedApproveCommand implements WorkflowCommandInterface {
  async execute(
    _subject: unknown,
    _context: WorkflowExecutionContext,
  ): Promise<CommandResult> {
    return { ok: true, code: "APPROVED" };
  }
}

@WorkflowCommand("decorated-reject")
class DecoratedRejectCommand implements WorkflowCommandInterface {
  async execute(
    _subject: unknown,
    _context: WorkflowExecutionContext,
  ): Promise<CommandResult> {
    return { ok: true, code: "REJECTED" };
  }
}

// Explicit (non-decorated) command
@Injectable()
class ExplicitShipCommand implements WorkflowCommandInterface {
  async execute(
    _subject: unknown,
    _context: WorkflowExecutionContext,
  ): Promise<CommandResult> {
    return { ok: true, code: "SHIPPED" };
  }
}

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

const workflowWithDecoratedCommands: WorkflowDefinition = {
  name: "decorated-wf",
  initialState: "pending",
  states: {
    pending: {
      events: {
        approve: {
          targetState: "approved",
          commands: [{ name: "decorated-approve" }],
        },
      },
    },
    approved: {},
  },
};

const workflowWithMixedCommands: WorkflowDefinition = {
  name: "mixed-wf",
  initialState: "pending",
  states: {
    pending: {
      events: {
        approve: {
          targetState: "approved",
          commands: [{ name: "decorated-approve" }],
        },
        ship: {
          targetState: "shipped",
          commands: [{ name: "explicit-ship" }],
        },
      },
    },
    approved: {},
    shipped: {},
  },
};

const workflowWithUnknownCommand: WorkflowDefinition = {
  name: "unknown-cmd-wf",
  initialState: "pending",
  states: {
    pending: {
      events: {
        doSomething: {
          targetState: "done",
          commands: [{ name: "nonexistent-command" }],
        },
      },
    },
    done: {},
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@WorkflowCommand decorator auto-discovery", () => {
  it("discovers decorated commands without explicit commands array", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [workflowWithDecoratedCommands],
          persistence: stubPersistence,
          clock: fixedClock,
        }),
      ],
      providers: [DecoratedApproveCommand],
    }).compile();

    const registry = moduleRef.get<WorkflowCommandRegistry>(WORKFLOW_COMMAND_REGISTRY);
    expect(registry.has("decorated-approve")).toBe(true);

    const command = registry.get("decorated-approve");
    expect(command).toBeInstanceOf(DecoratedApproveCommand);
  });

  it("decorator applies @Injectable automatically — no need for both decorators", async () => {
    // DecoratedApproveCommand only has @WorkflowCommand, not @Injectable
    // It should still be resolvable via NestJS DI
    const moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [workflowWithDecoratedCommands],
          persistence: stubPersistence,
          clock: fixedClock,
        }),
      ],
      providers: [DecoratedApproveCommand],
    }).compile();

    const command = moduleRef.get(DecoratedApproveCommand);
    expect(command).toBeInstanceOf(DecoratedApproveCommand);
  });

  it("supports mixed mode — some explicit, some decorated", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [workflowWithMixedCommands],
          commands: [{ name: "explicit-ship", useClass: ExplicitShipCommand }],
          persistence: stubPersistence,
          clock: fixedClock,
        }),
      ],
      providers: [DecoratedApproveCommand],
    }).compile();

    const registry = moduleRef.get<WorkflowCommandRegistry>(WORKFLOW_COMMAND_REGISTRY);

    // Decorated command
    expect(registry.has("decorated-approve")).toBe(true);
    expect(registry.get("decorated-approve")).toBeInstanceOf(DecoratedApproveCommand);

    // Explicit command
    expect(registry.has("explicit-ship")).toBe(true);
    expect(registry.get("explicit-ship")).toBeInstanceOf(ExplicitShipCommand);
  });

  it("throws on name conflict between explicit and decorated", async () => {
    // Register "decorated-approve" both ways
    await expect(
      Test.createTestingModule({
        imports: [
          WorkflowModule.forRoot({
            workflows: [],
            commands: [{ name: "decorated-approve", useClass: ExplicitShipCommand }],
            persistence: stubPersistence,
            clock: fixedClock,
          }),
        ],
        providers: [DecoratedApproveCommand],
      }).compile(),
    ).rejects.toThrow(WorkflowError);
  });

  it("backwards compatibility — explicit commands array still works without decorators", async () => {
    const simpleWorkflow: WorkflowDefinition = {
      name: "explicit-wf",
      initialState: "pending",
      states: {
        pending: {
          events: {
            ship: {
              targetState: "shipped",
              commands: [{ name: "explicit-ship" }],
            },
          },
        },
        shipped: {},
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [simpleWorkflow],
          commands: [{ name: "explicit-ship", useClass: ExplicitShipCommand }],
          persistence: stubPersistence,
          clock: fixedClock,
        }),
      ],
    }).compile();

    const registry = moduleRef.get<WorkflowCommandRegistry>(WORKFLOW_COMMAND_REGISTRY);
    expect(registry.has("explicit-ship")).toBe(true);
    expect(registry.get("explicit-ship")).toBeInstanceOf(ExplicitShipCommand);
  });

  it("works with forRootAsync", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRootAsync({
          useFactory: () => ({
            workflows: [workflowWithDecoratedCommands],
            persistence: stubPersistence,
            clock: fixedClock,
          }),
        }),
      ],
      providers: [DecoratedApproveCommand],
    }).compile();

    const registry = moduleRef.get<WorkflowCommandRegistry>(WORKFLOW_COMMAND_REGISTRY);
    expect(registry.has("decorated-approve")).toBe(true);
    expect(registry.get("decorated-approve")).toBeInstanceOf(DecoratedApproveCommand);
  });

  it("discovers multiple decorated commands", async () => {
    const workflow: WorkflowDefinition = {
      name: "multi-decorated-wf",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: {
              targetState: "approved",
              commands: [{ name: "decorated-approve" }],
            },
            reject: {
              targetState: "rejected",
              commands: [{ name: "decorated-reject" }],
            },
          },
        },
        approved: {},
        rejected: {},
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [workflow],
          persistence: stubPersistence,
          clock: fixedClock,
        }),
      ],
      providers: [DecoratedApproveCommand, DecoratedRejectCommand],
    }).compile();

    const registry = moduleRef.get<WorkflowCommandRegistry>(WORKFLOW_COMMAND_REGISTRY);
    expect(registry.has("decorated-approve")).toBe(true);
    expect(registry.has("decorated-reject")).toBe(true);
  });

  it("startup validation catches unknown command names in workflow definitions", async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          WorkflowModule.forRoot({
            workflows: [workflowWithUnknownCommand],
            persistence: stubPersistence,
            clock: fixedClock,
          }),
        ],
      }).compile(),
    ).rejects.toThrow(WorkflowDefinitionError);
  });

  it("startup validation passes when all commands are registered", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [workflowWithDecoratedCommands],
          persistence: stubPersistence,
          clock: fixedClock,
        }),
      ],
      providers: [DecoratedApproveCommand],
    }).compile();

    const registry = moduleRef.get<DefinitionRegistryType>(WORKFLOW_DEFINITION_REGISTRY);
    expect(registry.has("decorated-wf")).toBe(true);
  });
});
