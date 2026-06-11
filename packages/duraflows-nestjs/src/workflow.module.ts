import {
  Logger,
  Module,
  type DynamicModule,
  type Type,
  type Provider,
  type InjectionToken,
  type OptionalFactoryDependency,
} from "@nestjs/common";
import { DiscoveryModule, DiscoveryService, ModuleRef } from "@nestjs/core";
import type {
  WorkflowDefinition,
  WorkflowClock,
  WorkflowPersistenceProvider,
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
  WorkflowDefinitionRegistry,
  WorkflowObserver,
  ObserverErrorHandler,
  WorkflowGuard,
  WorkflowGuardRegistry,
} from "@duraflows/core";
import {
  InMemoryDefinitionRegistry,
  WorkflowRuntime,
  WorkflowValidator,
  WorkflowCompiler,
  InMemoryGuardRegistry,
} from "@duraflows/core";
import { NestCommandRegistry, type WorkflowCommandRegistration } from "./providers/nest-command-registry.js";
import { discoverDecoratedCommands, mergeCommandRegistrations } from "./providers/command-discovery.js";
import {
  WORKFLOW_RUNTIME,
  WORKFLOW_INSTANCE_STORE,
  WORKFLOW_HISTORY_STORE,
  WORKFLOW_COMMAND_REGISTRY,
  WORKFLOW_DEFINITION_REGISTRY,
  WORKFLOW_TRANSACTION_RUNNER,
  WORKFLOW_CLOCK,
  WORKFLOW_GUARD_REGISTRY,
} from "./providers/injection-tokens.js";
import { WorkflowService } from "./services/workflow.service.js";
import { WorkflowTimeoutService } from "./services/workflow-timeout.service.js";
import { WorkflowEventController } from "./controllers/workflow-event.controller.js";
import { WorkflowQueryController } from "./controllers/workflow-query.controller.js";
import { WorkflowTimeoutController } from "./controllers/workflow-timeout.controller.js";
import { WorkflowInstanceController } from "./controllers/workflow-instance.controller.js";

export interface WorkflowModuleOptions {
  workflows: WorkflowDefinition[];
  commands?: WorkflowCommandRegistration[];
  guards?: WorkflowGuard[];
  guardRegistry?: WorkflowGuardRegistry;
  observers?: WorkflowObserver[];
  onObserverError?: ObserverErrorHandler;
  persistence: WorkflowPersistenceProvider;
  clock?: WorkflowClock;
  enableControllers?: boolean;
}

export interface WorkflowModuleFactoryConfig {
  workflows: WorkflowDefinition[];
  persistence: WorkflowPersistenceProvider;
  clock?: WorkflowClock;
  guards?: WorkflowGuard[];
  guardRegistry?: WorkflowGuardRegistry;
  observers?: WorkflowObserver[];
  onObserverError?: ObserverErrorHandler;
}

export interface WorkflowModuleAsyncOptions<TArgs extends unknown[] = unknown[]> {
  imports?: Type<unknown>[];
  commands?: WorkflowCommandRegistration[];
  enableControllers?: boolean;
  useFactory: (...args: TArgs) => Promise<WorkflowModuleFactoryConfig> | WorkflowModuleFactoryConfig;
  /**
   * DI tokens resolved and passed to `useFactory`, positionally. The tuple
   * length is type-checked against the factory's parameter list when `TArgs`
   * is supplied (e.g. `forRootAsync<[Pool, AuditObserver]>({ ... })`).
   */
  inject?: { [K in keyof TArgs]: InjectionToken | OptionalFactoryDependency };
}

// Surfaces non-fatal definition warnings (e.g. unreachable states) that the
// registry would otherwise compute and discard.
const validationLogger = new Logger("WorkflowModule");
const logValidationWarning = (workflowName: string, warning: { path: string; message: string }): void => {
  validationLogger.warn(`Workflow "${workflowName}": ${warning.message} (${warning.path})`);
};

const EXPORTED_TOKENS = [
  WorkflowService,
  WorkflowTimeoutService,
  WORKFLOW_RUNTIME,
  WORKFLOW_INSTANCE_STORE,
  WORKFLOW_HISTORY_STORE,
  WORKFLOW_DEFINITION_REGISTRY,
  WORKFLOW_COMMAND_REGISTRY,
  WORKFLOW_GUARD_REGISTRY,
  WORKFLOW_TRANSACTION_RUNNER,
  WORKFLOW_CLOCK,
];

@Module({})
export class WorkflowModule {
  static forRoot(options: WorkflowModuleOptions): DynamicModule {
    if (options.guardRegistry && options.guards && options.guards.length > 0) {
      throw new Error(
        "WorkflowModule: cannot supply both `guards` and `guardRegistry` — they are mutually exclusive. Pass guards or a custom registry, not both.",
      );
    }

    const controllers = options.enableControllers
      ? [WorkflowInstanceController, WorkflowEventController, WorkflowQueryController, WorkflowTimeoutController]
      : [];

    const explicitCommands = options.commands ?? [];
    const commandClasses = explicitCommands.map((c) => c.useClass);
    const clock: WorkflowClock = options.clock ?? { now: () => new Date() };

    const providers: Provider[] = [
      ...commandClasses,
      {
        provide: WORKFLOW_COMMAND_REGISTRY,
        useFactory: (moduleRef: ModuleRef, discoveryService: DiscoveryService) => {
          const discovered = discoverDecoratedCommands(discoveryService);
          const merged = mergeCommandRegistrations(explicitCommands, discovered);
          return new NestCommandRegistry(moduleRef, merged);
        },
        inject: [ModuleRef, DiscoveryService],
      },
      {
        provide: WORKFLOW_GUARD_REGISTRY,
        // guards/guardRegistry mutual exclusion is enforced synchronously at
        // the top of forRoot, before this factory can ever run.
        useFactory: () => {
          if (options.guardRegistry) return options.guardRegistry;
          const registry = new InMemoryGuardRegistry();
          for (const guard of options.guards ?? []) {
            registry.register(guard.name, guard);
          }
          return registry;
        },
      },
      {
        provide: WORKFLOW_DEFINITION_REGISTRY,
        useFactory: (commandRegistry: NestCommandRegistry) => {
          const knownCommandNames = commandRegistry.getRegisteredNames();
          // Validate guard refs only when we own the registry (built-in path).
          // With a custom guardRegistry we can't enumerate names, so skip;
          // unresolved refs surface at runtime as WorkflowError.
          const knownGuardNames =
            options.guardRegistry !== undefined ? undefined : new Set((options.guards ?? []).map((g) => g.name));
          const registry = new InMemoryDefinitionRegistry({
            validator: new WorkflowValidator(),
            compiler: new WorkflowCompiler(),
            validationOptions: { knownCommandNames, knownGuardNames },
            onValidationWarning: logValidationWarning,
          });
          for (const workflow of options.workflows) {
            registry.register(workflow);
          }
          return registry;
        },
        inject: [WORKFLOW_COMMAND_REGISTRY],
      },
      {
        provide: WORKFLOW_INSTANCE_STORE,
        useValue: options.persistence.instanceStore,
      },
      {
        provide: WORKFLOW_HISTORY_STORE,
        useValue: options.persistence.historyStore,
      },
      {
        provide: WORKFLOW_TRANSACTION_RUNNER,
        useValue: options.persistence.transactionRunner,
      },
      {
        provide: WORKFLOW_CLOCK,
        useValue: clock,
      },
      {
        provide: WORKFLOW_RUNTIME,
        useFactory: (
          definitionRegistry: WorkflowDefinitionRegistry,
          commandRegistry: NestCommandRegistry,
          guardRegistry: WorkflowGuardRegistry,
          instanceStore: WorkflowInstanceStore,
          historyStore: WorkflowHistoryStore,
          transactionRunner: WorkflowTransactionRunner,
          wfClock: WorkflowClock,
        ) =>
          new WorkflowRuntime({
            definitionRegistry,
            commandRegistry,
            guardRegistry,
            instanceStore,
            historyStore,
            transactionRunner,
            clock: wfClock,
            observers: options.observers,
            onObserverError: options.onObserverError,
          }),
        inject: [
          WORKFLOW_DEFINITION_REGISTRY,
          WORKFLOW_COMMAND_REGISTRY,
          WORKFLOW_GUARD_REGISTRY,
          WORKFLOW_INSTANCE_STORE,
          WORKFLOW_HISTORY_STORE,
          WORKFLOW_TRANSACTION_RUNNER,
          WORKFLOW_CLOCK,
        ],
      },
      WorkflowService,
      WorkflowTimeoutService,
    ];

    return {
      module: WorkflowModule,
      global: true, // allow downstream feature modules to inject WorkflowService without re-importing forRoot
      imports: [DiscoveryModule],
      controllers,
      providers,
      exports: EXPORTED_TOKENS,
    };
  }

  static forRootAsync<TArgs extends unknown[] = unknown[]>(options: WorkflowModuleAsyncOptions<TArgs>): DynamicModule {
    const controllers = options.enableControllers
      ? [WorkflowInstanceController, WorkflowEventController, WorkflowQueryController, WorkflowTimeoutController]
      : [];

    const explicitCommands = options.commands ?? [];
    const commandClasses = explicitCommands.map((c) => c.useClass);

    const configProvider: Provider = {
      provide: "WORKFLOW_MODULE_OPTIONS",
      useFactory: options.useFactory,
      inject: (options.inject ?? []) as Array<InjectionToken | OptionalFactoryDependency>,
    };

    const providers: Provider[] = [
      configProvider,
      ...commandClasses,
      {
        provide: WORKFLOW_COMMAND_REGISTRY,
        useFactory: (moduleRef: ModuleRef, discoveryService: DiscoveryService) => {
          const discovered = discoverDecoratedCommands(discoveryService);
          const merged = mergeCommandRegistrations(explicitCommands, discovered);
          return new NestCommandRegistry(moduleRef, merged);
        },
        inject: [ModuleRef, DiscoveryService],
      },
      {
        provide: WORKFLOW_GUARD_REGISTRY,
        useFactory: (config: WorkflowModuleFactoryConfig) => {
          if (config.guardRegistry && config.guards && config.guards.length > 0) {
            throw new Error(
              "WorkflowModule: cannot supply both `guards` and `guardRegistry` — they are mutually exclusive. Pass guards or a custom registry, not both.",
            );
          }
          if (config.guardRegistry) return config.guardRegistry;
          const registry = new InMemoryGuardRegistry();
          for (const guard of config.guards ?? []) {
            registry.register(guard.name, guard);
          }
          return registry;
        },
        inject: ["WORKFLOW_MODULE_OPTIONS"],
      },
      {
        provide: WORKFLOW_DEFINITION_REGISTRY,
        useFactory: (config: WorkflowModuleFactoryConfig, commandRegistry: NestCommandRegistry) => {
          const knownCommandNames = commandRegistry.getRegisteredNames();
          // Validate guard refs only when we own the registry (built-in path).
          // With a custom guardRegistry we can't enumerate names, so skip;
          // unresolved refs surface at runtime as WorkflowError.
          const knownGuardNames =
            config.guardRegistry !== undefined ? undefined : new Set((config.guards ?? []).map((g) => g.name));
          const registry = new InMemoryDefinitionRegistry({
            validator: new WorkflowValidator(),
            compiler: new WorkflowCompiler(),
            validationOptions: { knownCommandNames, knownGuardNames },
            onValidationWarning: logValidationWarning,
          });
          for (const workflow of config.workflows) {
            registry.register(workflow);
          }
          return registry;
        },
        inject: ["WORKFLOW_MODULE_OPTIONS", WORKFLOW_COMMAND_REGISTRY],
      },
      {
        provide: WORKFLOW_INSTANCE_STORE,
        useFactory: (config: WorkflowModuleFactoryConfig) => config.persistence.instanceStore,
        inject: ["WORKFLOW_MODULE_OPTIONS"],
      },
      {
        provide: WORKFLOW_HISTORY_STORE,
        useFactory: (config: WorkflowModuleFactoryConfig) => config.persistence.historyStore,
        inject: ["WORKFLOW_MODULE_OPTIONS"],
      },
      {
        provide: WORKFLOW_TRANSACTION_RUNNER,
        useFactory: (config: WorkflowModuleFactoryConfig) => config.persistence.transactionRunner,
        inject: ["WORKFLOW_MODULE_OPTIONS"],
      },
      {
        provide: WORKFLOW_CLOCK,
        useFactory: (config: WorkflowModuleFactoryConfig): WorkflowClock => config.clock ?? { now: () => new Date() },
        inject: ["WORKFLOW_MODULE_OPTIONS"],
      },
      {
        provide: WORKFLOW_RUNTIME,
        useFactory: (
          config: WorkflowModuleFactoryConfig,
          definitionRegistry: WorkflowDefinitionRegistry,
          commandRegistry: NestCommandRegistry,
          guardRegistry: WorkflowGuardRegistry,
          instanceStore: WorkflowInstanceStore,
          historyStore: WorkflowHistoryStore,
          transactionRunner: WorkflowTransactionRunner,
          clock: WorkflowClock,
        ) =>
          new WorkflowRuntime({
            definitionRegistry,
            commandRegistry,
            guardRegistry,
            instanceStore,
            historyStore,
            transactionRunner,
            clock,
            observers: config.observers,
            onObserverError: config.onObserverError,
          }),
        inject: [
          "WORKFLOW_MODULE_OPTIONS",
          WORKFLOW_DEFINITION_REGISTRY,
          WORKFLOW_COMMAND_REGISTRY,
          WORKFLOW_GUARD_REGISTRY,
          WORKFLOW_INSTANCE_STORE,
          WORKFLOW_HISTORY_STORE,
          WORKFLOW_TRANSACTION_RUNNER,
          WORKFLOW_CLOCK,
        ],
      },
      WorkflowService,
      WorkflowTimeoutService,
    ];

    return {
      module: WorkflowModule,
      global: true, // allow downstream feature modules to inject WorkflowService without re-importing forRootAsync
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      controllers,
      providers,
      exports: EXPORTED_TOKENS,
    };
  }
}
