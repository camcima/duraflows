import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { Test, type TestingModule } from "@nestjs/testing";
import { Injectable } from "@nestjs/common";
import {
  WorkflowModule,
  WorkflowService,
  WorkflowTimeoutService,
  WORKFLOW_RUNTIME,
  WORKFLOW_DEFINITION_REGISTRY,
  WORKFLOW_COMMAND_REGISTRY,
  WorkflowInstanceController,
  WorkflowEventController,
  WorkflowQueryController,
  WorkflowTimeoutController,
  type WorkflowModuleOptions,
} from "@duraflows/nestjs";
import {
  WorkflowRuntime,
  InMemoryGuardRegistry,
  type WorkflowDefinition,
  type WorkflowGuard,
  type WorkflowCommand,
  type CommandResult,
  type WorkflowExecutionContext,
  type WorkflowInstanceStore,
  type WorkflowHistoryStore,
  type WorkflowHistoryRecord,
  type WorkflowTransactionRunner,
  type WorkflowInstance,
  type WorkflowPersistenceProvider,
  type WorkflowClock,
  type WorkflowDefinitionRegistry,
  type WorkflowCommandRegistry,
  type StateEnterEvent,
} from "@duraflows/core";

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

const fixedDate = new Date("2026-01-15T12:00:00.000Z");
const fixedClock: WorkflowClock = { now: () => fixedDate };

const stubPersistence: WorkflowPersistenceProvider = {
  instanceStore: stubInstanceStore,
  historyStore: stubHistoryStore,
  transactionRunner: stubTransactionRunner,
};

// ---------------------------------------------------------------------------
// Test command
// ---------------------------------------------------------------------------

@Injectable()
class TestApproveCommand implements WorkflowCommand {
  async execute(_subject: unknown, _context: WorkflowExecutionContext): Promise<CommandResult> {
    return { ok: true, code: "APPROVED" };
  }
}

// ---------------------------------------------------------------------------
// Test workflow definition
// ---------------------------------------------------------------------------

const testWorkflow: WorkflowDefinition = {
  name: "test-order",
  initialState: "pending",
  states: {
    pending: {
      events: {
        approve: {
          targetState: "approved",
          commands: [{ name: "test-approve" }],
        },
      },
    },
    approved: {},
  },
};

// ---------------------------------------------------------------------------
// Helper: default module options
// ---------------------------------------------------------------------------

function defaultOptions(overrides?: Partial<WorkflowModuleOptions>): WorkflowModuleOptions {
  return {
    workflows: [testWorkflow],
    commands: [{ name: "test-approve", useClass: TestApproveCommand }],
    persistence: stubPersistence,
    clock: fixedClock,
    enableControllers: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkflowModule.forRoot()", () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkflowModule.forRoot(defaultOptions())],
    }).compile();
  });

  it("compiles the module successfully", () => {
    expect(moduleRef).toBeDefined();
  });

  it("provides an injectable WorkflowService", () => {
    const service = moduleRef.get(WorkflowService);
    expect(service).toBeInstanceOf(WorkflowService);
  });

  it("provides an injectable WorkflowTimeoutService", () => {
    const service = moduleRef.get(WorkflowTimeoutService);
    expect(service).toBeInstanceOf(WorkflowTimeoutService);
  });

  it("resolves WORKFLOW_RUNTIME token to a WorkflowRuntime instance", () => {
    const runtime = moduleRef.get(WORKFLOW_RUNTIME);
    expect(runtime).toBeInstanceOf(WorkflowRuntime);
  });

  it("resolves WORKFLOW_DEFINITION_REGISTRY containing registered workflows", () => {
    const registry = moduleRef.get<WorkflowDefinitionRegistry>(WORKFLOW_DEFINITION_REGISTRY);
    expect(registry).toBeDefined();
    expect(registry.has("test-order")).toBe(true);
    expect(registry.get("test-order")).toEqual(testWorkflow);
  });

  it("resolves WORKFLOW_COMMAND_REGISTRY that can find registered commands", () => {
    const registry = moduleRef.get<WorkflowCommandRegistry>(WORKFLOW_COMMAND_REGISTRY);
    expect(registry).toBeDefined();
    expect(registry.has("test-approve")).toBe(true);

    const command = registry.get("test-approve");
    expect(command).toBeInstanceOf(TestApproveCommand);
  });

  describe("controller registration", () => {
    it("registers controllers when enableControllers is true", async () => {
      const mod = await Test.createTestingModule({
        imports: [WorkflowModule.forRoot(defaultOptions({ enableControllers: true }))],
      }).compile();

      const instanceCtrl = mod.get(WorkflowInstanceController);
      const eventCtrl = mod.get(WorkflowEventController);
      const queryCtrl = mod.get(WorkflowQueryController);
      const timeoutCtrl = mod.get(WorkflowTimeoutController);

      expect(instanceCtrl).toBeInstanceOf(WorkflowInstanceController);
      expect(eventCtrl).toBeInstanceOf(WorkflowEventController);
      expect(queryCtrl).toBeInstanceOf(WorkflowQueryController);
      expect(timeoutCtrl).toBeInstanceOf(WorkflowTimeoutController);
    });

    it("does NOT register controllers when enableControllers is false", async () => {
      const mod = await Test.createTestingModule({
        imports: [WorkflowModule.forRoot(defaultOptions({ enableControllers: false }))],
      }).compile();

      expect(() => mod.get(WorkflowInstanceController)).toThrow();
      expect(() => mod.get(WorkflowEventController)).toThrow();
      expect(() => mod.get(WorkflowQueryController)).toThrow();
      expect(() => mod.get(WorkflowTimeoutController)).toThrow();
    });
  });

  it("registers a guards option and validates definitions referencing those guards", async () => {
    const guards: WorkflowGuard[] = [{ name: "isVerified", evaluate: () => false }];

    const guardedDefinition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const moduleWithGuards = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          ...defaultOptions(),
          workflows: [guardedDefinition],
          commands: [],
          guards,
        }),
      ],
    }).compile();

    const definitionRegistry = moduleWithGuards.get<WorkflowDefinitionRegistry>(WORKFLOW_DEFINITION_REGISTRY);
    expect(definitionRegistry.has("guarded-wf")).toBe(true);
  });

  it("rejects definitions that reference an unregistered guard", async () => {
    const guardedDefinition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "missingGuard" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    await expect(
      Test.createTestingModule({
        imports: [
          WorkflowModule.forRoot({
            ...defaultOptions(),
            workflows: [guardedDefinition],
            commands: [],
            guards: [],
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/Guard "missingGuard" is not registered/);
  });

  it("uses a custom guardRegistry when provided, ignoring the guards array", async () => {
    // Guards array is empty; the prebuilt registry carries the only guard.
    const customRegistry = new InMemoryGuardRegistry();
    customRegistry.register("isVerified", { name: "isVerified", evaluate: () => true });

    const guardedDefinition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: { guard: { name: "isVerified" }, targetState: "submitted" },
          },
        },
        submitted: {},
      },
    };

    // Note: when only `guardRegistry` (no `guards` array) is provided, knownGuardNames
    // is empty, so guard-ref validation is skipped — matching how custom command
    // registries behave today.
    const moduleWithCustomRegistry = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          ...defaultOptions(),
          workflows: [guardedDefinition],
          commands: [],
          guardRegistry: customRegistry,
        }),
      ],
    }).compile();

    const definitionRegistry = moduleWithCustomRegistry.get<WorkflowDefinitionRegistry>(WORKFLOW_DEFINITION_REGISTRY);
    expect(definitionRegistry.has("guarded-wf")).toBe(true);
  });

  it("accepts an empty guards array alongside a custom guardRegistry without false-rejecting refs", async () => {
    // Regression: previously knownGuardNames was derived purely from `guards`,
    // so `guards: []` + custom `guardRegistry` produced an empty Set and
    // bootstrap validation rejected every ref the custom registry could resolve.
    const customRegistry = new InMemoryGuardRegistry();
    customRegistry.register("isVerified", { name: "isVerified", evaluate: () => true });

    const guardedDefinition: WorkflowDefinition = {
      name: "guarded-empty-array-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: { guard: { name: "isVerified" }, targetState: "submitted" },
          },
        },
        submitted: {},
      },
    };

    const mod = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          ...defaultOptions(),
          workflows: [guardedDefinition],
          commands: [],
          guards: [],
          guardRegistry: customRegistry,
        }),
      ],
    }).compile();

    const definitionRegistry = mod.get<WorkflowDefinitionRegistry>(WORKFLOW_DEFINITION_REGISTRY);
    expect(definitionRegistry.has("guarded-empty-array-wf")).toBe(true);
  });

  it("throws when both guards and guardRegistry are supplied", () => {
    const customRegistry = new InMemoryGuardRegistry();
    customRegistry.register("isVerified", { name: "isVerified", evaluate: () => true });

    const guardedDefinition: WorkflowDefinition = {
      name: "guarded-conflict-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: { guard: { name: "isVerified" }, targetState: "submitted" },
          },
        },
        submitted: {},
      },
    };

    expect(() =>
      WorkflowModule.forRoot({
        ...defaultOptions(),
        workflows: [guardedDefinition],
        commands: [],
        guards: [{ name: "isVerified", evaluate: () => false }],
        guardRegistry: customRegistry,
      }),
    ).toThrow(/cannot supply both `guards` and `guardRegistry`/);
  });

  it("forwards observers from WorkflowModule.forRoot to WorkflowRuntime", async () => {
    const captured: { state: string }[] = [];

    const definition: WorkflowDefinition = {
      name: "nestjs-observer-wf",
      initialState: "ready",
      states: { ready: {} },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        WorkflowModule.forRoot({
          workflows: [definition],
          persistence: stubPersistence,
          clock: fixedClock,
          observers: [
            {
              name: "nest-test-observer",
              onEnter: (event: StateEnterEvent) => {
                captured.push({ state: event.state });
              },
            },
          ],
        }),
      ],
    }).compile();

    const runtime = moduleRef.get<WorkflowRuntime>(WORKFLOW_RUNTIME);
    await runtime.createInstance({ workflowName: "nestjs-observer-wf" });

    expect(captured).toEqual([{ state: "ready" }]);

    await moduleRef.close();
  });
});
