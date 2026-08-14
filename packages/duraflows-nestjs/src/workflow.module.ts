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
  WORKFLOW_MODULE_OPTIONS,
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

const CONTROLLERS = [
  WorkflowInstanceController,
  WorkflowEventController,
  WorkflowQueryController,
  WorkflowTimeoutController,
];

/**
 * `guards` and `guardRegistry` are mutually exclusive: with a custom registry
 * duraflows cannot enumerate guard names, so it can neither merge the array in
 * nor validate definition refs against it.
 *
 * forRoot calls this eagerly, so the error surfaces at module definition.
 * forRootAsync only learns its config once the factory resolves, so it calls
 * this from inside the guard-registry provider instead. Same message, and each
 * entry point keeps the failure timing it has always had.
 */
function assertGuardConfigExclusive(config: WorkflowModuleFactoryConfig): void {
  if (config.guardRegistry && config.guards && config.guards.length > 0) {
    throw new Error(
      "WorkflowModule: cannot supply both `guards` and `guardRegistry` — they are mutually exclusive. Pass guards or a custom registry, not both.",
    );
  }
}

/**
 * The provider graph shared by both entry points. Every factory reads its
 * configuration from WORKFLOW_MODULE_OPTIONS — supplied as a value by forRoot
 * and as the caller's factory by forRootAsync — so the wiring downstream is
 * identical and cannot drift between the sync and async paths.
 */
function buildWorkflowProviders(explicitCommands: WorkflowCommandRegistration[]): Provider[] {
  return [
    ...explicitCommands.map((c) => c.useClass),
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
        // Redundant on the forRoot path, which already threw at module
        // definition, but this is forRootAsync's only opportunity to check.
        assertGuardConfigExclusive(config);
        if (config.guardRegistry) return config.guardRegistry;
        const registry = new InMemoryGuardRegistry();
        for (const guard of config.guards ?? []) {
          registry.register(guard.name, guard);
        }
        return registry;
      },
      inject: [WORKFLOW_MODULE_OPTIONS],
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
      inject: [WORKFLOW_MODULE_OPTIONS, WORKFLOW_COMMAND_REGISTRY],
    },
    {
      provide: WORKFLOW_INSTANCE_STORE,
      useFactory: (config: WorkflowModuleFactoryConfig) => config.persistence.instanceStore,
      inject: [WORKFLOW_MODULE_OPTIONS],
    },
    {
      provide: WORKFLOW_HISTORY_STORE,
      useFactory: (config: WorkflowModuleFactoryConfig) => config.persistence.historyStore,
      inject: [WORKFLOW_MODULE_OPTIONS],
    },
    {
      provide: WORKFLOW_TRANSACTION_RUNNER,
      useFactory: (config: WorkflowModuleFactoryConfig) => config.persistence.transactionRunner,
      inject: [WORKFLOW_MODULE_OPTIONS],
    },
    {
      provide: WORKFLOW_CLOCK,
      useFactory: (config: WorkflowModuleFactoryConfig): WorkflowClock => config.clock ?? { now: () => new Date() },
      inject: [WORKFLOW_MODULE_OPTIONS],
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
        WORKFLOW_MODULE_OPTIONS,
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
}

@Module({})
export class WorkflowModule {
  static forRoot(options: WorkflowModuleOptions): DynamicModule {
    // Eager, so a misconfiguration fails where it was written rather than at
    // container bootstrap.
    assertGuardConfigExclusive(options);

    return {
      module: WorkflowModule,
      global: true, // allow downstream feature modules to inject WorkflowService without re-importing forRoot
      imports: [DiscoveryModule],
      controllers: options.enableControllers ? [...CONTROLLERS] : [],
      providers: [
        { provide: WORKFLOW_MODULE_OPTIONS, useValue: options },
        ...buildWorkflowProviders(options.commands ?? []),
      ],
      exports: EXPORTED_TOKENS,
    };
  }

  static forRootAsync<TArgs extends unknown[] = unknown[]>(options: WorkflowModuleAsyncOptions<TArgs>): DynamicModule {
    return {
      module: WorkflowModule,
      global: true, // allow downstream feature modules to inject WorkflowService without re-importing forRootAsync
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      controllers: options.enableControllers ? [...CONTROLLERS] : [],
      providers: [
        {
          provide: WORKFLOW_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: (options.inject ?? []) as Array<InjectionToken | OptionalFactoryDependency>,
        },
        ...buildWorkflowProviders(options.commands ?? []),
      ],
      exports: EXPORTED_TOKENS,
    };
  }
}
