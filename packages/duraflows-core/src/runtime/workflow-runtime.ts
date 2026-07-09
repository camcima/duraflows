import { randomUUID } from "node:crypto";
import type { WorkflowDefinitionRegistry } from "../registry/definition-registry.js";
import type { WorkflowDefinition } from "../types/definition.js";
import { deepFreeze } from "../util/deep-freeze.js";
import type {
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowHistoryRecord,
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
import type { WorkflowGuardRegistry } from "../registry/guard-registry.js";
import { WorkflowInstanceNotFoundError, InvalidArgumentError } from "../errors/index.js";
import { WorkflowHandle } from "./workflow-handle.js";
import type { WorkflowObserver, StateEnterEvent, ObserverErrorHandler } from "../types/observer.js";
import { ObserverRegistry } from "./observer-registry.js";

const DEFAULT_MAX_ON_ENTER_DEPTH = 10;

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${name} must be a non-negative integer, got ${value}`);
  }
}

export interface WorkflowRuntimeOptions {
  definitionRegistry: WorkflowDefinitionRegistry;
  commandRegistry: WorkflowCommandRegistry;
  guardRegistry?: WorkflowGuardRegistry;
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
  clock: WorkflowClock;
  maxOnEnterDepth?: number;
  observers?: readonly WorkflowObserver[];
  onObserverError?: ObserverErrorHandler;
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
  private readonly observerRegistry: ObserverRegistry;

  constructor(options: WorkflowRuntimeOptions) {
    this.definitionRegistry = options.definitionRegistry;
    this.instanceStore = options.instanceStore;
    this.historyStore = options.historyStore;
    this.transactionRunner = options.transactionRunner;
    this.clock = options.clock;
    this.compiler = new WorkflowCompiler();
    const commandExecutor = new CommandExecutor(options.commandRegistry);
    this.eventExecutor = new EventExecutor(commandExecutor, options.guardRegistry);
    this.onEnterExecutor = new OnEnterExecutor(commandExecutor);
    this.timeoutResolver = new TimeoutResolver();
    if (options.maxOnEnterDepth !== undefined) {
      assertPositiveSafeInteger(options.maxOnEnterDepth, "maxOnEnterDepth");
    }
    this.maxOnEnterDepth = options.maxOnEnterDepth ?? DEFAULT_MAX_ON_ENTER_DEPTH;
    this.observerRegistry = new ObserverRegistry(options.observers ?? [], options.onObserverError);
  }

  addObserver(observer: WorkflowObserver): void {
    this.observerRegistry.add(observer);
  }

  async createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance> {
    const definition = this.definitionRegistry.get(input.workflowName);

    const now = this.clock.now();

    const stateDef = definition.states[definition.initialState];
    const context: Record<string, unknown> = {
      ...structuredClone(stateDef?.context ?? {}),
      ...structuredClone(input.context ?? {}),
    };

    const expiresAt = this.timeoutResolver.computeDeadline(definition, definition.initialState, now);

    const instance: WorkflowInstance = {
      uuid: randomUUID(),
      workflowName: definition.name,
      currentState: definition.initialState,
      version: 0,
      expiresAt,
      lastTransitionAt: now,
      context,
      metadata: structuredClone(input.metadata ?? {}),
      createdAt: now,
      updatedAt: now,
    };

    const eventsToFire: StateEnterEvent[] = [];

    if (stateDef?.onEnter) {
      const result = await this.transactionRunner.runInTransaction(async () => {
        await this.instanceStore.create(instance);

        const executionContext: WorkflowExecutionContext = {
          triggerMetadata: deepFreeze(structuredClone(input.triggerMetadata ?? {})),
          now: this.clock.now(),
          context: { ...instance.context },
          metadata: deepFreeze(structuredClone(instance.metadata)),
          commandMetadata: deepFreeze({}),
          fromState: null,
          toState: definition.initialState,
          transitionUuid: randomUUID(),
        };

        eventsToFire.push({
          workflowName: instance.workflowName,
          instanceUuid: instance.uuid,
          state: definition.initialState,
          fromState: null,
          toState: definition.initialState,
          transitionUuid: executionContext.transitionUuid,
          triggerEvent: null,
          context: deepFreeze(structuredClone(instance.context)),
          metadata: deepFreeze(structuredClone(instance.metadata)),
          triggerMetadata: deepFreeze(structuredClone(input.triggerMetadata ?? {})),
          occurredAt: now,
        });

        await this.processOnEnterChain(instance, definition, executionContext, undefined, eventsToFire);

        return instance;
      });

      for (const event of eventsToFire) {
        await this.observerRegistry.fireOnEnter(event);
      }

      return result;
    }

    await this.transactionRunner.runInTransaction(async () => {
      await this.instanceStore.create(instance);
    });

    eventsToFire.push({
      workflowName: instance.workflowName,
      instanceUuid: instance.uuid,
      state: definition.initialState,
      fromState: null,
      toState: definition.initialState,
      transitionUuid: randomUUID(),
      triggerEvent: null,
      context: deepFreeze(structuredClone(instance.context)),
      metadata: deepFreeze(structuredClone(instance.metadata)),
      triggerMetadata: deepFreeze(structuredClone(input.triggerMetadata ?? {})),
      occurredAt: now,
    });

    for (const event of eventsToFire) {
      await this.observerRegistry.fireOnEnter(event);
    }

    return instance;
  }

  async triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult> {
    const eventsToFire: StateEnterEvent[] = [];

    const result = await this.transactionRunner.runInTransaction(async () => {
      const instance = await this.instanceStore.lockByUuid(input.workflowInstanceUuid);
      if (!instance) {
        throw new WorkflowInstanceNotFoundError(input.workflowInstanceUuid);
      }

      const definition = this.definitionRegistry.get(instance.workflowName);
      const compiled = this.compiler.compile(definition);

      const eventDef = definition.states[instance.currentState]?.events?.[input.eventName];
      const prospectiveToState = eventDef?.targetState ?? instance.currentState;

      const executionContext: WorkflowExecutionContext = {
        triggerMetadata: deepFreeze(structuredClone(input.triggerMetadata ?? {})),
        now: this.clock.now(),
        context: { ...instance.context },
        metadata: deepFreeze(structuredClone(instance.metadata)),
        commandMetadata: deepFreeze({}),
        fromState: instance.currentState,
        toState: prospectiveToState,
        transitionUuid: randomUUID(),
      };

      const eventResult = await this.eventExecutor.execute(
        compiled,
        instance.currentState,
        input.eventName,
        instance.uuid,
        input.subject,
        executionContext,
      );

      const now = this.clock.now();

      if (eventResult.outcome === "guard-rejected") {
        const lastHistoryUuid = await this.historyStore.append({
          workflowInstanceUuid: instance.uuid,
          fromState: eventResult.fromState,
          eventName: input.eventName,
          toState: eventResult.toState,
          outcome: "guard-rejected",
          rejectedBy: eventResult.rejectedBy,
          commandResultsJson: [],
          triggerMetadata: structuredClone(input.triggerMetadata ?? {}),
        });

        return {
          outcome: "guard-rejected" as const,
          fromState: eventResult.fromState,
          toState: eventResult.toState,
          commandResults: [] as CommandResult[],
          rejectedBy: eventResult.rejectedBy,
          historyUuid: lastHistoryUuid,
        };
      }

      instance.currentState = eventResult.toState;
      instance.version++;
      instance.lastTransitionAt = now;
      instance.updatedAt = now;

      const newStateDef = definition.states[eventResult.toState];
      instance.context = {
        ...executionContext.context,
        ...structuredClone(newStateDef?.context ?? {}),
      };

      instance.expiresAt = this.timeoutResolver.computeDeadline(definition, eventResult.toState, now);

      await this.instanceStore.update(instance);

      let errorMessage: string | undefined;
      if (eventResult.outcome === "failure" && eventResult.commandResults.length > 0) {
        const lastResult = eventResult.commandResults[eventResult.commandResults.length - 1];
        if (!lastResult.ok) {
          errorMessage = lastResult.message ?? lastResult.code ?? "Command failed";
        }
      }

      let lastHistoryUuid = await this.historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: eventResult.fromState,
        eventName: input.eventName,
        toState: eventResult.toState,
        outcome: eventResult.outcome,
        errorMessage,
        commandResultsJson: eventResult.commandResults,
        triggerMetadata: structuredClone(input.triggerMetadata ?? {}),
      });

      eventsToFire.push({
        workflowName: instance.workflowName,
        instanceUuid: instance.uuid,
        state: eventResult.toState,
        fromState: eventResult.fromState,
        toState: eventResult.toState,
        transitionUuid: executionContext.transitionUuid,
        triggerEvent: input.eventName,
        context: deepFreeze(structuredClone(instance.context)),
        metadata: deepFreeze(structuredClone(instance.metadata)),
        triggerMetadata: deepFreeze(structuredClone(input.triggerMetadata ?? {})),
        occurredAt: now,
      });

      executionContext.context = { ...instance.context };

      const onEnterResult = await this.processOnEnterChain(
        instance,
        definition,
        executionContext,
        input.subject,
        eventsToFire,
      );

      const allCommandResults = [...eventResult.commandResults, ...onEnterResult.commandResults];
      if (onEnterResult.lastHistoryUuid) {
        lastHistoryUuid = onEnterResult.lastHistoryUuid;
      }

      const finalOutcome: "success" | "failure" =
        eventResult.outcome === "failure" || onEnterResult.chainOutcome === "failure" ? "failure" : "success";

      return {
        outcome: finalOutcome,
        fromState: eventResult.fromState,
        toState: instance.currentState,
        commandResults: allCommandResults,
        historyUuid: lastHistoryUuid,
      };
    });

    for (const event of eventsToFire) {
      await this.observerRegistry.fireOnEnter(event);
    }

    return result;
  }

  async processExpiredWorkflows(input?: ProcessExpiredWorkflowsInput): Promise<ProcessExpiredWorkflowsResult> {
    const limit = input?.limit ?? 100;
    assertPositiveSafeInteger(limit, "limit");
    const now = this.clock.now();
    const eventsToFire: StateEnterEvent[] = [];
    let processed = 0;
    let rejected = 0;
    const businessFailed: Array<{ uuid: string; finalState: string }> = [];
    const failed: Array<{ uuid: string; error: string }> = [];

    // Step 1: find expired instances (short-lived txn; locks released immediately).
    const expired = await this.transactionRunner.runInTransaction(async () => {
      return this.instanceStore.findExpired(limit, now);
    });

    // Step 2: process each instance in its own transaction.
    for (const staleInstance of expired) {
      const startIdx = eventsToFire.length;
      let outcome: "transitioned" | "business-failed" | "rejected" | null = null;
      let finalState: string | null = null;
      try {
        await this.transactionRunner.runInTransaction(async () => {
          // Re-lock the instance fresh inside this transaction (locks from Step 1 were released).
          const instance = await this.instanceStore.lockByUuid(staleInstance.uuid);
          if (!instance) {
            // Instance disappeared (another worker deleted it); skip silently.
            return;
          }

          // Re-verify still expired (another worker may have already processed it).
          if (!instance.expiresAt || instance.expiresAt > this.clock.now()) {
            return;
          }

          // Resolve definition + eventName from the FRESHLY-LOCKED state, not the pre-lock snapshot.
          const definition = this.definitionRegistry.get(instance.workflowName);
          const eventName = this.timeoutResolver.getTimeoutEventName(definition, instance.currentState);

          if (!eventName) {
            // No timeout event for this state; just clear the stale deadline.
            instance.expiresAt = null;
            instance.version++;
            instance.updatedAt = this.clock.now();
            await this.instanceStore.update(instance);
            return;
          }

          outcome = await this.processTimeoutEvent(instance, definition, eventName, eventsToFire);
          finalState = instance.currentState;
        });
        if (outcome === "transitioned" || outcome === "business-failed") processed++;
        if (outcome === "business-failed" && finalState !== null) {
          businessFailed.push({ uuid: staleInstance.uuid, finalState });
        }
        if (outcome === "rejected") rejected++;
      } catch (error: unknown) {
        // Per-instance transaction rolled back. Drop any events queued for this instance.
        eventsToFire.length = startIdx;
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ uuid: staleInstance.uuid, error: message });
      }
    }

    // Step 3: fire observers post-commit (only for successful instances).
    for (const event of eventsToFire) {
      await this.observerRegistry.fireOnEnter(event);
    }

    return { processed, rejected, businessFailed, failed };
  }

  private async processTimeoutEvent(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    eventName: string,
    eventsToFire: StateEnterEvent[],
  ): Promise<"transitioned" | "business-failed" | "rejected"> {
    const compiled = this.compiler.compile(definition);

    const timeoutEventDef = definition.states[instance.currentState]?.events?.[eventName];
    const prospectiveToState = timeoutEventDef?.targetState ?? instance.currentState;

    const executionContext: WorkflowExecutionContext = {
      triggerMetadata: deepFreeze({ source: "timeout" }),
      now: this.clock.now(),
      context: { ...instance.context },
      metadata: deepFreeze(structuredClone(instance.metadata)),
      commandMetadata: deepFreeze({}),
      fromState: instance.currentState,
      toState: prospectiveToState,
      transitionUuid: randomUUID(),
    };

    const result = await this.eventExecutor.execute(
      compiled,
      instance.currentState,
      eventName,
      instance.uuid,
      undefined,
      executionContext,
    );

    if (result.outcome === "guard-rejected") {
      const now = this.clock.now();
      instance.expiresAt = null;
      instance.version++;
      instance.lastTransitionAt = now;
      instance.updatedAt = now;
      await this.instanceStore.update(instance);

      await this.historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: result.fromState,
        eventName,
        toState: result.toState,
        outcome: "guard-rejected",
        rejectedBy: result.rejectedBy,
        commandResultsJson: [],
        triggerMetadata: { source: "timeout" },
      });
      return "rejected";
    }

    const now = this.clock.now();
    instance.currentState = result.toState;
    instance.version++;
    instance.lastTransitionAt = now;
    instance.updatedAt = now;

    const newStateDef = definition.states[result.toState];
    instance.context = {
      ...executionContext.context,
      ...structuredClone(newStateDef?.context ?? {}),
    };

    instance.expiresAt = this.timeoutResolver.computeDeadline(definition, result.toState, now);

    await this.instanceStore.update(instance);

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

    eventsToFire.push({
      workflowName: instance.workflowName,
      instanceUuid: instance.uuid,
      state: result.toState,
      fromState: result.fromState,
      toState: result.toState,
      transitionUuid: executionContext.transitionUuid,
      triggerEvent: eventName,
      context: deepFreeze(structuredClone(instance.context)),
      metadata: deepFreeze(structuredClone(instance.metadata)),
      triggerMetadata: deepFreeze({ source: "timeout" }),
      occurredAt: now,
    });

    executionContext.context = { ...instance.context };

    const onEnterResult = await this.processOnEnterChain(
      instance,
      definition,
      executionContext,
      undefined,
      eventsToFire,
    );
    return result.outcome === "failure" || onEnterResult.chainOutcome === "failure"
      ? "business-failed"
      : "transitioned";
  }

  private async processOnEnterChain(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    executionContext: WorkflowExecutionContext,
    subject: unknown,
    eventsToFire: StateEnterEvent[],
  ): Promise<{ commandResults: CommandResult[]; lastHistoryUuid: string | null; chainOutcome: "success" | "failure" }> {
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
        ...structuredClone(hopStateDef?.context ?? {}),
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

      eventsToFire.push({
        workflowName: instance.workflowName,
        instanceUuid: instance.uuid,
        state: hop.toState,
        fromState: hop.fromState,
        toState: hop.toState,
        transitionUuid: hop.transitionUuid,
        triggerEvent: "onEnter",
        context: deepFreeze(structuredClone(instance.context)),
        metadata: deepFreeze(structuredClone(instance.metadata)),
        triggerMetadata: deepFreeze({ source: "onEnter" }),
        occurredAt: now,
      });

      allCommandResults.push(...hop.commandResults);
    }

    return { commandResults: allCommandResults, lastHistoryUuid, chainOutcome: chainResult.outcome };
  }

  async getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]> {
    const instance = await this.instanceStore.findByUuid(input.workflowInstanceUuid);
    if (!instance) {
      throw new WorkflowInstanceNotFoundError(input.workflowInstanceUuid);
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

  async getInstance(uuid: string): Promise<WorkflowInstance | null> {
    return this.instanceStore.findByUuid(uuid);
  }

  async getHistory(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    if (options?.limit !== undefined) {
      assertPositiveSafeInteger(options.limit, "limit");
    }
    if (options?.offset !== undefined) {
      assertNonNegativeSafeInteger(options.offset, "offset");
    }
    return this.historyStore.findByInstanceUuid(workflowInstanceUuid, options);
  }

  getHandle(uuid: string): WorkflowHandle {
    return new WorkflowHandle(uuid, this);
  }
}
