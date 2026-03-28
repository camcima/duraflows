import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { Test, type TestingModule } from "@nestjs/testing";
import { Injectable, Module } from "@nestjs/common";
import {
  WorkflowModule,
  WorkflowService,
  WorkflowTimeoutService,
  WORKFLOW_RUNTIME,
  WORKFLOW_COMMAND_REGISTRY,
  WorkflowInstanceController,
  WorkflowEventController,
  WorkflowQueryController,
  WorkflowTimeoutController,
  type WorkflowModuleAsyncOptions,
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
class TestShipCommand implements WorkflowCommand {
  async execute(_subject: unknown, _context: WorkflowExecutionContext): Promise<CommandResult> {
    return { ok: true, code: "SHIPPED" };
  }
}

// ---------------------------------------------------------------------------
// Test workflow definition
// ---------------------------------------------------------------------------

const testWorkflow: WorkflowDefinition = {
  name: "test-shipping",
  initialState: "waiting",
  states: {
    waiting: {
      events: {
        ship: {
          targetState: "shipped",
          commands: [{ name: "test-ship" }],
        },
      },
    },
    shipped: {},
  },
};

// ---------------------------------------------------------------------------
// External config provider (simulates an injected dependency)
// ---------------------------------------------------------------------------

const DB_URL = "DB_URL";

@Injectable()
class ConfigService {
  getDbUrl(): string {
    return "postgres://localhost/test";
  }
}

@Module({
  providers: [ConfigService, { provide: DB_URL, useValue: "postgres://localhost/test" }],
  exports: [ConfigService, DB_URL],
})
class ConfigModule {}

// ---------------------------------------------------------------------------
// Helper: default async options
// ---------------------------------------------------------------------------

function defaultAsyncOptions(overrides?: Partial<WorkflowModuleAsyncOptions>): WorkflowModuleAsyncOptions {
  return {
    commands: [{ name: "test-ship", useClass: TestShipCommand }],
    enableControllers: true,
    useFactory: () => ({
      workflows: [testWorkflow],
      persistence: stubPersistence,
      clock: fixedClock,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkflowModule.forRootAsync()", () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkflowModule.forRootAsync(defaultAsyncOptions())],
    }).compile();
  });

  it("compiles the module with an async factory", () => {
    expect(moduleRef).toBeDefined();
  });

  it("resolves async factory and makes providers available", async () => {
    const runtime = moduleRef.get(WORKFLOW_RUNTIME);
    expect(runtime).toBeInstanceOf(WorkflowRuntime);
  });

  it("provides an injectable WorkflowService", () => {
    const service = moduleRef.get(WorkflowService);
    expect(service).toBeInstanceOf(WorkflowService);
  });

  it("resolves WORKFLOW_RUNTIME token to a WorkflowRuntime instance", () => {
    const runtime = moduleRef.get(WORKFLOW_RUNTIME);
    expect(runtime).toBeInstanceOf(WorkflowRuntime);
  });

  describe("C1 fix: command classes registered as NestJS providers", () => {
    it("resolves command classes through the module", () => {
      // C1: command useClass entries must be registered as NestJS providers
      // so that ModuleRef.get() can resolve them inside NestCommandRegistry.
      const command = moduleRef.get(TestShipCommand);
      expect(command).toBeInstanceOf(TestShipCommand);
    });

    it("resolves commands through the command registry", () => {
      const registry = moduleRef.get<WorkflowCommandRegistry>(WORKFLOW_COMMAND_REGISTRY);
      expect(registry.has("test-ship")).toBe(true);

      const command = registry.get("test-ship");
      expect(command).toBeInstanceOf(TestShipCommand);
    });
  });

  describe("C2 fix: controllers conditionally registered", () => {
    it("registers controllers when enableControllers is true", async () => {
      const mod = await Test.createTestingModule({
        imports: [WorkflowModule.forRootAsync(defaultAsyncOptions({ enableControllers: true }))],
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
        imports: [WorkflowModule.forRootAsync(defaultAsyncOptions({ enableControllers: false }))],
      }).compile();

      expect(() => mod.get(WorkflowInstanceController)).toThrow();
      expect(() => mod.get(WorkflowEventController)).toThrow();
      expect(() => mod.get(WorkflowQueryController)).toThrow();
      expect(() => mod.get(WorkflowTimeoutController)).toThrow();
    });

    it("does NOT register controllers when enableControllers is omitted (defaults to falsy)", async () => {
      const mod = await Test.createTestingModule({
        imports: [WorkflowModule.forRootAsync(defaultAsyncOptions({ enableControllers: undefined }))],
      }).compile();

      expect(() => mod.get(WorkflowInstanceController)).toThrow();
      expect(() => mod.get(WorkflowEventController)).toThrow();
    });
  });

  describe("async factory with injected dependencies", () => {
    it("injects external providers into the factory", async () => {
      let capturedUrl: string | undefined;

      const mod = await Test.createTestingModule({
        imports: [
          WorkflowModule.forRootAsync({
            imports: [ConfigModule],
            commands: [{ name: "test-ship", useClass: TestShipCommand }],
            enableControllers: false,
            useFactory: (configService: ConfigService) => {
              capturedUrl = configService.getDbUrl();
              return {
                workflows: [testWorkflow],
                persistence: stubPersistence,
                clock: fixedClock,
              };
            },
            inject: [ConfigService],
          }),
        ],
      }).compile();

      expect(capturedUrl).toBe("postgres://localhost/test");
      expect(mod.get(WORKFLOW_RUNTIME)).toBeInstanceOf(WorkflowRuntime);
    });
  });
});
