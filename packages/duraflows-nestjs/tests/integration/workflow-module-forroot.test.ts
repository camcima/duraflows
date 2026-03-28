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
} from "@camcima/duraflows-nestjs";
import {
  WorkflowRuntime,
  type WorkflowDefinition,
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
  async execute(
    _subject: unknown,
    _context: WorkflowExecutionContext,
  ): Promise<CommandResult> {
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

function defaultOptions(
  overrides?: Partial<WorkflowModuleOptions>,
): WorkflowModuleOptions {
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
    const registry = moduleRef.get<WorkflowDefinitionRegistry>(
      WORKFLOW_DEFINITION_REGISTRY,
    );
    expect(registry).toBeDefined();
    expect(registry.has("test-order")).toBe(true);
    expect(registry.get("test-order")).toEqual(testWorkflow);
  });

  it("resolves WORKFLOW_COMMAND_REGISTRY that can find registered commands", () => {
    const registry = moduleRef.get<WorkflowCommandRegistry>(
      WORKFLOW_COMMAND_REGISTRY,
    );
    expect(registry).toBeDefined();
    expect(registry.has("test-approve")).toBe(true);

    const command = registry.get("test-approve");
    expect(command).toBeInstanceOf(TestApproveCommand);
  });

  describe("controller registration", () => {
    it("registers controllers when enableControllers is true", async () => {
      const mod = await Test.createTestingModule({
        imports: [
          WorkflowModule.forRoot(defaultOptions({ enableControllers: true })),
        ],
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
        imports: [
          WorkflowModule.forRoot(defaultOptions({ enableControllers: false })),
        ],
      }).compile();

      expect(() => mod.get(WorkflowInstanceController)).toThrow();
      expect(() => mod.get(WorkflowEventController)).toThrow();
      expect(() => mod.get(WorkflowQueryController)).toThrow();
      expect(() => mod.get(WorkflowTimeoutController)).toThrow();
    });
  });
});
