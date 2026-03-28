// Module
export { WorkflowModule } from "./workflow.module.js";
export type {
  WorkflowModuleOptions,
  WorkflowModuleAsyncOptions,
  WorkflowModuleFactoryConfig,
} from "./workflow.module.js";

// Services
export { WorkflowService } from "./services/workflow.service.js";
export { WorkflowTimeoutService } from "./services/workflow-timeout.service.js";

// Providers
export {
  WORKFLOW_RUNTIME,
  WORKFLOW_INSTANCE_STORE,
  WORKFLOW_HISTORY_STORE,
  WORKFLOW_COMMAND_REGISTRY,
  WORKFLOW_DEFINITION_REGISTRY,
  WORKFLOW_TRANSACTION_RUNNER,
  WORKFLOW_CLOCK,
} from "./providers/injection-tokens.js";
export { NestCommandRegistry } from "./providers/nest-command-registry.js";
export type { WorkflowCommandRegistration } from "./providers/nest-command-registry.js";

// Decorators
export { WorkflowCommand, WORKFLOW_COMMAND_METADATA_KEY } from "./decorators/workflow-command.decorator.js";

// Controllers
export { WorkflowInstanceController } from "./controllers/workflow-instance.controller.js";
export { WorkflowEventController } from "./controllers/workflow-event.controller.js";
export { WorkflowQueryController } from "./controllers/workflow-query.controller.js";
export { WorkflowTimeoutController } from "./controllers/workflow-timeout.controller.js";

// DTOs
export {
  TriggerEventDto,
  TriggerEventParamsDto,
  HistoryQueryDto,
  HistoryParamsDto,
  AvailableEventsParamsDto,
  TimeoutProcessQueryDto,
  CreateInstanceDto,
} from "./controllers/dto/index.js";

// Re-export workflow-core public API for convenience
export type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  WorkflowEventDefinition,
  WorkflowOnEnterDefinition,
  WorkflowCommandRef,
  WorkflowTimeoutDefinition,
  TriggerType,
  CommandResult,
  WorkflowExecutionContext,
  WorkflowInstance,
  WorkflowExecutionResult,
  AvailableWorkflowEvent,
  CreateWorkflowInstanceInput,
  TriggerWorkflowEventInput,
  ProcessExpiredWorkflowsInput,
  ProcessExpiredWorkflowsResult,
  GetAvailableEventsInput,
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowHistoryRecord,
  WorkflowTransactionRunner,
  WorkflowClock,
  WorkflowPersistenceProvider,
  WorkflowDefinitionRegistry,
  WorkflowCommandRegistry,
  ValidationResult,
  ValidationError,
  CompiledWorkflow,
  OnEnterChainResult,
  OnEnterHopResult,
} from "@camcima/duraflows-core";
export {
  WorkflowError,
  WorkflowDefinitionError,
  InvalidEventError,
  CommandFailureError,
  OnEnterDepthExceededError,
  WorkflowValidator,
  WorkflowCompiler,
  CommandExecutor,
  EventExecutor,
  OnEnterExecutor,
  TimeoutResolver,
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
} from "@camcima/duraflows-core";
