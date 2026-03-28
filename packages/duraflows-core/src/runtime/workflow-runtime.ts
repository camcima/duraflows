import { randomUUID } from "node:crypto";
import type { WorkflowDefinitionRegistry } from "../registry/definition-registry.js";
import type { WorkflowDefinition } from "../types/definition.js";

function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return obj;
}
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowTransactionRunner,
  WorkflowClock,
} from "../types/persistence.js";
import type {
  CreateWorkflowInstanceInput,
  TriggerWorkflowEventInput,
  ProcessExpiredWorkflowsInput,
  ProcessExpiredWorkflowsResult,
  GetAvailableEventsInput,
  WorkflowInstance,
  WorkflowExecutionResult,
  WorkflowExecutionContext,
  AvailableWorkflowEvent,
  CommandResult,
} from "../types/runtime.js";
import { WorkflowCompiler } from "../compilation/workflow-compiler.js";
import { CommandExecutor } from "../execution/command-executor.js";
import { EventExecutor } from "../execution/event-executor.js";
import { OnEnterExecutor } from "../execution/on-enter-executor.js";
import { TimeoutResolver } from "../execution/timeout-resolver.js";
import type { WorkflowCommandRegistry } from "../registry/command-registry.js";
import { WorkflowError } from "../errors/index.js";

const DEFAULT_MAX_ON_ENTER_DEPTH = 10;

export interface WorkflowRuntimeOptions {
  definitionRegistry: WorkflowDefinitionRegistry;
  commandRegistry: WorkflowCommandRegistry;
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
  clock: WorkflowClock;
  maxOnEnterDepth?: number;
}

export class WorkflowRuntime {
  private readonly definitionRegistry: WorkflowDefinitionRegistry;
  private readonly instanceStore: WorkflowInstanceStore;
  private readonly historyStore: WorkflowHistoryStore;
  private readonly transactionRunner: WorkflowTransactionRunner;
  private readonly clock: WorkflowClock;
  private readonly compiler: WorkflowCompiler;
  private readonly eventExecutor: EventExecutor;
  private readonly onEnterExecutor: OnEnterExecutor;
  private readonly timeoutResolver: TimeoutResolver;
  private readonly maxOnEnterDepth: number;

  constructor(options: WorkflowRuntimeOptions) {
    this.definitionRegistry = options.definitionRegistry;
    this.instanceStore = options.instanceStore;
    this.historyStore = options.historyStore;
    this.transactionRunner = options.transactionRunner;
    this.clock = options.clock;
    this.compiler = new WorkflowCompiler();
    const commandExecutor = new CommandExecutor(options.commandRegistry);
    this.eventExecutor = new EventExecutor(commandExecutor);
    this.onEnterExecutor = new OnEnterExecutor(commandExecutor);
    this.timeoutResolver = new TimeoutResolver();
    this.maxOnEnterDepth = options.maxOnEnterDepth ?? DEFAULT_MAX_ON_ENTER_DEPTH;
  }

  async createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance> {
    const definition = this.definitionRegistry.get(input.workflowName);

    const now = this.clock.now();

    // Seed context: state defaults first, user input wins on top
    const stateDef = definition.states[definition.initialState];
    const context: Record<string, unknown> = {
      ...(stateDef?.context ?? {}),
      ...(input.context ?? {}),
    };

    // Compute timeout deadline for initial state
    const expiresAt = this.timeoutResolver.computeDeadline(definition, definition.initialState, now);

    const instance: WorkflowInstance = {
      uuid: randomUUID(),
      workflowName: definition.name,
      currentState: definition.initialState,
      version: 0,
      expiresAt,
      lastTransitionAt: now,
      context,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    // Check if initial state has onEnter — if so, wrap in transaction
    if (stateDef?.onEnter) {
      return this.transactionRunner.runInTransaction(async () => {
        await this.instanceStore.create(instance);

        const executionContext: WorkflowExecutionContext = {
          triggerMetadata: deepFreeze({ ...(input.triggerMetadata ?? {}) }),
          now: this.clock.now(),
          context: { ...instance.context },
          metadata: deepFreeze({ ...instance.metadata }),
        };

        await this.processOnEnterChain(instance, definition, executionContext, undefined);

        return instance;
      });
    }

    await this.instanceStore.create(instance);
    return instance;
  }

  async triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult> {
    return this.transactionRunner.runInTransaction(async () => {
      const instance = await this.instanceStore.lockByUuid(input.workflowInstanceUuid);
      if (!instance) {
        throw new WorkflowError(`Workflow instance "${input.workflowInstanceUuid}" not found`);
      }

      const definition = this.definitionRegistry.get(instance.workflowName);
      const compiled = this.compiler.compile(definition);

      // Build execution context with instance's mutable context and immutable metadata
      const executionContext: WorkflowExecutionContext = {
        triggerMetadata: deepFreeze({ ...(input.triggerMetadata ?? {}) }),
        now: this.clock.now(),
        context: { ...instance.context },
        metadata: deepFreeze({ ...instance.metadata }),
      };

      const result = await this.eventExecutor.execute(
        compiled,
        instance.currentState,
        input.eventName,
        instance.uuid,
        input.subject,
        executionContext,
      );

      // Update instance
      const now = this.clock.now();
      instance.currentState = result.toState;
      instance.version++;
      instance.lastTransitionAt = now;
      instance.updatedAt = now;

      // Persist context mutations from commands, then merge state-defined context on top
      const newStateDef = definition.states[result.toState];
      instance.context = {
        ...executionContext.context,
        ...(newStateDef?.context ?? {}),
      };

      // Compute timeout deadline for new state
      instance.expiresAt = this.timeoutResolver.computeDeadline(definition, result.toState, now);

      await this.instanceStore.update(instance);

      // Extract error message from last failed command (if any)
      let errorMessage: string | undefined;
      if (result.outcome === "failure" && result.commandResults.length > 0) {
        const lastResult = result.commandResults[result.commandResults.length - 1];
        if (!lastResult.ok) {
          errorMessage = lastResult.message ?? lastResult.code ?? "Command failed";
        }
      }

      // Append history
      let lastHistoryUuid = await this.historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: result.fromState,
        eventName: input.eventName,
        toState: result.toState,
        outcome: result.outcome,
        errorMessage,
        commandResultsJson: result.commandResults,
        triggerMetadata: input.triggerMetadata,
      });

      // Update execution context to reflect merged state context for onEnter commands
      executionContext.context = { ...instance.context };

      // Process onEnter chain on the new state
      const onEnterResult = await this.processOnEnterChain(instance, definition, executionContext, input.subject);

      const allCommandResults = [...result.commandResults, ...onEnterResult.commandResults];
      if (onEnterResult.lastHistoryUuid) {
        lastHistoryUuid = onEnterResult.lastHistoryUuid;
      }

      // Determine final outcome
      let finalOutcome = result.outcome;
      if (onEnterResult.commandResults.length > 0) {
        // If there were onEnter hops, check if the last hop had a failure
        const lastOnEnterResult = onEnterResult.commandResults[onEnterResult.commandResults.length - 1];
        if (lastOnEnterResult && !lastOnEnterResult.ok) {
          finalOutcome = "failure";
        }
      }

      return {
        outcome: finalOutcome,
        fromState: result.fromState,
        toState: instance.currentState,
        commandResults: allCommandResults,
        historyUuid: lastHistoryUuid,
      };
    });
  }

  async processExpiredWorkflows(input?: ProcessExpiredWorkflowsInput): Promise<ProcessExpiredWorkflowsResult> {
    const limit = input?.limit ?? 100;
    const now = this.clock.now();

    return this.transactionRunner.runInTransaction(async () => {
      const expired = await this.instanceStore.findExpired(limit, now);
      let processed = 0;
      const failed: Array<{ uuid: string; error: string }> = [];

      for (const instance of expired) {
        try {
          const definition = this.definitionRegistry.get(instance.workflowName);
          const eventName = this.timeoutResolver.getTimeoutEventName(definition, instance.currentState);

          if (!eventName) {
            instance.expiresAt = null;
            instance.version++;
            instance.updatedAt = this.clock.now();
            await this.instanceStore.update(instance);
            continue;
          }

          await this.processTimeoutEvent(instance, definition, eventName);
          processed++;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ uuid: instance.uuid, error: message });
        }
      }

      return { processed, failed };
    });
  }

  private async processTimeoutEvent(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    eventName: string,
  ): Promise<void> {
    const compiled = this.compiler.compile(definition);

    const executionContext: WorkflowExecutionContext = {
      triggerMetadata: deepFreeze({ source: "timeout" }),
      now: this.clock.now(),
      context: { ...instance.context },
      metadata: deepFreeze({ ...instance.metadata }),
    };

    const result = await this.eventExecutor.execute(
      compiled,
      instance.currentState,
      eventName,
      instance.uuid,
      undefined,
      executionContext,
    );

    // Update instance
    const now = this.clock.now();
    instance.currentState = result.toState;
    instance.version++;
    instance.lastTransitionAt = now;
    instance.updatedAt = now;

    const newStateDef = definition.states[result.toState];
    instance.context = {
      ...executionContext.context,
      ...(newStateDef?.context ?? {}),
    };

    instance.expiresAt = this.timeoutResolver.computeDeadline(definition, result.toState, now);

    await this.instanceStore.update(instance);

    // Extract error message
    let errorMessage: string | undefined;
    if (result.outcome === "failure" && result.commandResults.length > 0) {
      const lastResult = result.commandResults[result.commandResults.length - 1];
      if (!lastResult.ok) {
        errorMessage = lastResult.message ?? lastResult.code ?? "Command failed";
      }
    }

    await this.historyStore.append({
      workflowInstanceUuid: instance.uuid,
      fromState: result.fromState,
      eventName,
      toState: result.toState,
      outcome: result.outcome,
      errorMessage,
      commandResultsJson: result.commandResults,
      triggerMetadata: { source: "timeout" },
    });

    // Update execution context to reflect merged state context for onEnter commands
    executionContext.context = { ...instance.context };

    // Process onEnter chain on the new state
    await this.processOnEnterChain(instance, definition, executionContext, undefined);
  }

  private async processOnEnterChain(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    executionContext: WorkflowExecutionContext,
    subject: unknown,
  ): Promise<{ commandResults: CommandResult[]; lastHistoryUuid: string | null }> {
    const chainResult = await this.onEnterExecutor.executeChain(
      definition,
      instance.currentState,
      instance.uuid,
      subject,
      executionContext,
      this.maxOnEnterDepth,
    );

    const allCommandResults: CommandResult[] = [];
    let lastHistoryUuid: string | null = null;

    for (const hop of chainResult.hops) {
      // Update instance for this hop
      const now = this.clock.now();
      instance.currentState = hop.toState;
      instance.version++;
      instance.lastTransitionAt = now;
      instance.updatedAt = now;

      // Merge context: command mutations are already in executionContext.context,
      // then overlay the new state's context on top
      const hopStateDef = definition.states[hop.toState];
      instance.context = {
        ...executionContext.context,
        ...(hopStateDef?.context ?? {}),
      };
      // Update execution context so next hop's commands see merged state context
      executionContext.context = { ...instance.context };

      // Compute timeout deadline for this hop's state
      instance.expiresAt = this.timeoutResolver.computeDeadline(definition, hop.toState, now);

      await this.instanceStore.update(instance);

      // Extract error message for this hop
      let errorMessage: string | undefined;
      if (hop.outcome === "failure" && hop.commandResults.length > 0) {
        const lastResult = hop.commandResults[hop.commandResults.length - 1];
        if (!lastResult.ok) {
          errorMessage = lastResult.message ?? lastResult.code ?? "Command failed";
        }
      }

      // Append history for this hop
      lastHistoryUuid = await this.historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: hop.fromState,
        eventName: "onEnter",
        toState: hop.toState,
        outcome: hop.outcome,
        errorMessage,
        commandResultsJson: hop.commandResults,
        triggerMetadata: { source: "onEnter" },
      });

      allCommandResults.push(...hop.commandResults);
    }

    return { commandResults: allCommandResults, lastHistoryUuid };
  }

  async getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]> {
    const instance = await this.instanceStore.findByUuid(input.workflowInstanceUuid);
    if (!instance) {
      throw new WorkflowError(`Workflow instance "${input.workflowInstanceUuid}" not found`);
    }

    const definition = this.definitionRegistry.get(instance.workflowName);
    const stateDef = definition.states[instance.currentState];
    if (!stateDef?.events) return [];

    const events: AvailableWorkflowEvent[] = [];

    for (const [eventName, eventDef] of Object.entries(stateDef.events)) {
      events.push({
        eventName,
        targetState: eventDef.targetState,
        errorState: eventDef.errorState,
        hasCommands: (eventDef.commands?.length ?? 0) > 0,
        hasTimeout: !!eventDef.timeout,
        metadata: eventDef.metadata,
      });
    }

    return events;
  }
}
