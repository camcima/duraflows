import { Module, type DynamicModule, type Type, type Provider, type InjectionToken } from "@nestjs/common";
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
} from "@duraflows/core";
import { InMemoryDefinitionRegistry, WorkflowRuntime, WorkflowValidator, WorkflowCompiler } from "@duraflows/core";
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
  observers?: WorkflowObserver[];
  onObserverError?: ObserverErrorHandler;
}

export interface WorkflowModuleAsyncOptions<TArgs extends unknown[] = unknown[]> {
  imports?: Type<unknown>[];
  commands?: WorkflowCommandRegistration[];
  enableControllers?: boolean;
  useFactory: (...args: TArgs) => Promise<WorkflowModuleFactoryConfig> | WorkflowModuleFactoryConfig;
  inject?: InjectionToken[];
}

const EXPORTED_TOKENS = [
  WorkflowService,
  WorkflowTimeoutService,
  WORKFLOW_RUNTIME,
  WORKFLOW_INSTANCE_STORE,
  WORKFLOW_HISTORY_STORE,
  WORKFLOW_DEFINITION_REGISTRY,
  WORKFLOW_COMMAND_REGISTRY,
  WORKFLOW_TRANSACTION_RUNNER,
  WORKFLOW_CLOCK,
];

@Module({})
export class WorkflowModule {
  static forRoot(options: WorkflowModuleOptions): DynamicModule {
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
        provide: WORKFLOW_DEFINITION_REGISTRY,
        useFactory: (commandRegistry: NestCommandRegistry) => {
          const knownCommandNames = commandRegistry.getRegisteredNames();
          const registry = new InMemoryDefinitionRegistry({
            validator: new WorkflowValidator(),
            compiler: new WorkflowCompiler(),
            validationOptions: { knownCommandNames },
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
          instanceStore: WorkflowInstanceStore,
          historyStore: WorkflowHistoryStore,
          transactionRunner: WorkflowTransactionRunner,
          wfClock: WorkflowClock,
        ) =>
          new WorkflowRuntime({
            definitionRegistry,
            commandRegistry,
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
      inject: options.inject ?? [],
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
        provide: WORKFLOW_DEFINITION_REGISTRY,
        useFactory: (config: WorkflowModuleFactoryConfig, commandRegistry: NestCommandRegistry) => {
          const knownCommandNames = commandRegistry.getRegisteredNames();
          const registry = new InMemoryDefinitionRegistry({
            validator: new WorkflowValidator(),
            compiler: new WorkflowCompiler(),
            validationOptions: { knownCommandNames },
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
          instanceStore: WorkflowInstanceStore,
          historyStore: WorkflowHistoryStore,
          transactionRunner: WorkflowTransactionRunner,
          clock: WorkflowClock,
        ) =>
          new WorkflowRuntime({
            definitionRegistry,
            commandRegistry,
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
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      controllers,
      providers,
      exports: EXPORTED_TOKENS,
    };
  }
}
