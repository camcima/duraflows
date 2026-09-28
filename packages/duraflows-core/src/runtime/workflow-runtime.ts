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
  WorkflowDefinitionStore,
} from "../types/persistence.js";
import type {
  CreateWorkflowInstanceInput,
  TriggerWorkflowEventInput,
  ProcessExpiredWorkflowsInput,
  ProcessExpiredWorkflowsResult,
  FindParkedTimeoutsInput,
  GetAvailableEventsInput,
  WorkflowInstance,
  WorkflowExecutionResult,
  WorkflowExecutionContext,
  AvailableWorkflowEvent,
  CommandResult,
  WorkflowTimeoutRetry,
  WorkflowTimeoutRetryOptions,
  DefinitionVersionSummary,
} from "../types/runtime.js";
import { WorkflowCompiler } from "../compilation/workflow-compiler.js";
import { CommandExecutor } from "../execution/command-executor.js";
import { EventExecutor } from "../execution/event-executor.js";
import { OnEnterExecutor } from "../execution/on-enter-executor.js";
import { TimeoutResolver } from "../execution/timeout-resolver.js";
import type { WorkflowCommandRegistry } from "../registry/command-registry.js";
import type { WorkflowGuardRegistry } from "../registry/guard-registry.js";
import {
  WorkflowInstanceNotFoundError,
  WorkflowDefinitionError,
  WorkflowError,
  InvalidArgumentError,
} from "../errors/index.js";
import { WorkflowHandle } from "./workflow-handle.js";
import type { WorkflowObserver, StateEnterEvent, ObserverErrorHandler } from "../types/observer.js";
import { ObserverRegistry } from "./observer-registry.js";
import { computeDefinitionHash } from "../util/definition-hash.js";
import { assertNonNegativeSafeInteger, assertPositiveSafeInteger } from "../util/assert.js";
import { TimeoutRetryPolicy } from "./timeout-retry-policy.js";
import { DefinitionResolver } from "./definition-resolver.js";
import { countActiveInstances, findUnresolvableVersions } from "./definition-executability.js";

const DEFAULT_MAX_ON_ENTER_DEPTH = 10;

/**
 * Whether `instance`'s timeout should be processed at `now`: expired, not parked, and any scheduled retry reached.
 *
 * The boundary is inclusive, while `findExpired`'s scan is strict (`< now`). That is safe: the scan
 * decides what enters a sweep, and this re-check runs at the same or a later `now` (given a
 * non-decreasing clock), so anything the scan returned still passes here. If a clock steps back,
 * the instance is merely skipped until the next sweep. It only has to reject instances another worker
 * moved, rescheduled, or parked in between.
 */
function isTimeoutDue(instance: WorkflowInstance, now: Date): boolean {
  if (!instance.expiresAt || instance.expiresAt > now) return false;
  if (instance.timeoutRetry?.parkedAt) return false;
  const retryAt = instance.timeoutRetry?.retryAt;
  return !retryAt || retryAt <= now;
}

/** Whether `instance` is still the one a sweep scanned: same state, deadline and failure count. */
function matchesTimeoutSnapshot(instance: WorkflowInstance, snapshot: WorkflowInstance): boolean {
  return (
    instance.currentState === snapshot.currentState &&
    instance.expiresAt?.getTime() === snapshot.expiresAt?.getTime() &&
    (instance.timeoutRetry?.attempts ?? 0) === (snapshot.timeoutRetry?.attempts ?? 0)
  );
}

/**
 * Pulls the operator-facing message out of a failed transition. Only the last
 * command result matters — the executor stops at the first failure, so every
 * earlier result succeeded.
 */
function extractErrorMessage(
  outcome: "success" | "failure" | "guard-rejected",
  commandResults: readonly CommandResult[],
): string | undefined {
  if (outcome !== "failure" || commandResults.length === 0) {
    return undefined;
  }
  const lastResult = commandResults[commandResults.length - 1];
  // `ok` here is defensive: the executor stops at the first failure, so a
  // "failure" outcome always ends on a failed result.
  return lastResult.ok ? undefined : (lastResult.message ?? lastResult.code ?? "Command failed");
}

/**
 * Builds the post-commit observer payload for a state entry. Context and
 * metadata are cloned and frozen so an observer cannot reach back into the live
 * instance. `triggerMetadata` is frozen in place, so callers must pass an object
 * they own — a fresh literal or a clone, never the caller's input directly.
 */
function buildStateEnterEvent(
  instance: WorkflowInstance,
  params: {
    fromState: string | null;
    toState: string;
    transitionUuid: string;
    triggerEvent: string | null;
    triggerMetadata: Record<string, unknown>;
    occurredAt: Date;
  },
): StateEnterEvent {
  return {
    workflowName: instance.workflowName,
    instanceUuid: instance.uuid,
    state: params.toState,
    fromState: params.fromState,
    toState: params.toState,
    transitionUuid: params.transitionUuid,
    triggerEvent: params.triggerEvent,
    context: deepFreeze(structuredClone(instance.context)),
    metadata: deepFreeze(structuredClone(instance.metadata)),
    triggerMetadata: deepFreeze(params.triggerMetadata),
    occurredAt: params.occurredAt,
  };
}

export interface WorkflowRuntimeOptions {
  definitionRegistry: WorkflowDefinitionRegistry;
  commandRegistry: WorkflowCommandRegistry;
  guardRegistry?: WorkflowGuardRegistry;
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
  clock: WorkflowClock;
  /**
   * Optional store for definition snapshots. When present, `initialize()`
   * (called explicitly or lazily by the first mutating operation) syncs every
   * registered definition into it and fails if a definition's content changed
   * without a version bump, and pinned instances load older versions from it.
   * When absent, versioning is inert: every instance executes the latest
   * registered definition (a warning is logged once while any is pinned).
   */
  definitionStore?: WorkflowDefinitionStore;
  maxOnEnterDepth?: number;
  observers?: readonly WorkflowObserver[];
  onObserverError?: ObserverErrorHandler;
  /**
   * How `processExpiredWorkflows` retries an instance whose timeout processing
   * fails: exponential backoff, then parking. See {@link WorkflowTimeoutRetryOptions}.
   */
  timeoutRetry?: WorkflowTimeoutRetryOptions;
  /**
   * What `initialize()` does when a stored definition version that still has
   * active instances references a command or guard that is not registered:
   * `"fail"` (default) throws `WorkflowDefinitionError`, `"warn"` logs it.
   * Only runs with a `definitionStore`.
   */
  onUnresolvable?: "fail" | "warn";
}

export class WorkflowRuntime {
  private readonly definitionRegistry: WorkflowDefinitionRegistry;
  private readonly instanceStore: WorkflowInstanceStore;
  private readonly historyStore: WorkflowHistoryStore;
  private readonly transactionRunner: WorkflowTransactionRunner;
  private readonly clock: WorkflowClock;
  private readonly definitionStore?: WorkflowDefinitionStore;
  private initPromise: Promise<void> | null = null;
  private readonly compiler: WorkflowCompiler;
  private readonly definitionResolver: DefinitionResolver;
  private readonly eventExecutor: EventExecutor;
  private readonly onEnterExecutor: OnEnterExecutor;
  private readonly timeoutResolver: TimeoutResolver;
  private readonly maxOnEnterDepth: number;
  private readonly observerRegistry: ObserverRegistry;
  private readonly timeoutRetryPolicy: TimeoutRetryPolicy;
  private readonly commandRegistry: WorkflowCommandRegistry;
  private readonly guardRegistry?: WorkflowGuardRegistry;
  private readonly onUnresolvable: "fail" | "warn";

  constructor(options: WorkflowRuntimeOptions) {
    this.definitionRegistry = options.definitionRegistry;
    this.instanceStore = options.instanceStore;
    this.historyStore = options.historyStore;
    this.transactionRunner = options.transactionRunner;
    this.clock = options.clock;
    this.definitionStore = options.definitionStore;
    this.commandRegistry = options.commandRegistry;
    this.guardRegistry = options.guardRegistry;
    if (
      options.onUnresolvable !== undefined &&
      options.onUnresolvable !== "fail" &&
      options.onUnresolvable !== "warn"
    ) {
      throw new InvalidArgumentError(
        `onUnresolvable must be "fail" or "warn", got ${JSON.stringify(options.onUnresolvable)}`,
      );
    }
    this.onUnresolvable = options.onUnresolvable ?? "fail";
    this.compiler = new WorkflowCompiler();
    this.definitionResolver = new DefinitionResolver({
      definitionRegistry: options.definitionRegistry,
      compiler: this.compiler,
      definitionStore: options.definitionStore,
    });
    const commandExecutor = new CommandExecutor(options.commandRegistry);
    this.eventExecutor = new EventExecutor(commandExecutor, options.guardRegistry);
    this.onEnterExecutor = new OnEnterExecutor(commandExecutor);
    this.timeoutResolver = new TimeoutResolver();
    if (options.maxOnEnterDepth !== undefined) {
      assertPositiveSafeInteger(options.maxOnEnterDepth, "maxOnEnterDepth");
    }
    this.maxOnEnterDepth = options.maxOnEnterDepth ?? DEFAULT_MAX_ON_ENTER_DEPTH;
    this.observerRegistry = new ObserverRegistry(options.observers ?? [], options.onObserverError);
    this.timeoutRetryPolicy = new TimeoutRetryPolicy(options.timeoutRetry);
  }

  addObserver(observer: WorkflowObserver): void {
    this.observerRegistry.add(observer);
  }

  /**
   * Syncs registered definitions into the definition store and enforces the
   * version-bump guard. Idempotent: concurrent and repeated calls share one
   * sync. A failed sync is not cached — the next call retries. Called lazily
   * by mutating operations, but calling it explicitly at boot is recommended
   * so registration errors surface at startup. With a definition store, it
   * then checks that every stored version with active instances can still
   * execute (see `onUnresolvable`).
   */
  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.syncDefinitions()
        .then(() => this.checkExecutability())
        .catch((error: unknown) => {
          this.initPromise = null;
          throw error;
        });
    }
    return this.initPromise;
  }

  private async checkExecutability(): Promise<void> {
    if (!this.definitionStore) return;
    const problems = await findUnresolvableVersions({
      definitionRegistry: this.definitionRegistry,
      definitionStore: this.definitionStore,
      instanceStore: this.instanceStore,
      commandRegistry: this.commandRegistry,
      guardRegistry: this.guardRegistry,
    });
    if (problems.length === 0) return;
    const summary = problems.map((p) => p.description).join("; ");
    if (this.onUnresolvable === "warn") {
      console.warn(`[duraflows] ${summary}`);
      return;
    }
    // WorkflowDefinitionError prefixes `Workflow "<first>": `; drop the first
    // description's own copy so every workflow is named exactly once.
    const first = problems[0];
    const details = summary.slice(`Workflow "${first.workflowName}": `.length);
    throw new WorkflowDefinitionError(
      first.workflowName,
      `${details}. Register the missing commands and guards, set versionPolicy: "latest" on the workflow, ` +
        `or set onUnresolvable: "warn".`,
    );
  }

  private async syncDefinitions(): Promise<void> {
    if (!this.definitionStore) return;
    for (const definition of this.definitionRegistry.getAll()) {
      const version = this.definitionVersionOf(definition);
      const contentHash = computeDefinitionHash(definition);
      const stored = await this.definitionStore.ensure({
        workflowName: definition.name,
        version,
        contentHash,
        definitionJson: definition,
      });
      if (stored.contentHash !== contentHash) {
        throw new WorkflowDefinitionError(
          definition.name,
          `Definition content changed but version ${version} was not bumped ` +
            `(stored ${stored.contentHash}, registered ${contentHash}). ` +
            `Bump the definition's "version" field to publish the change.`,
        );
      }
    }
  }

  async createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance> {
    await this.initialize();
    const { definition } = this.definitionResolver.forNewInstance(input.workflowName);

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
      definitionVersion: this.definitionVersionOf(definition),
      expiresAt,
      timeoutRetry: null,
      lastTransitionAt: now,
      context,
      metadata: structuredClone(input.metadata ?? {}),
      createdAt: now,
      updatedAt: now,
    };

    if (stateDef?.onEnter) {
      return this.runWithObservers(async (eventsToFire) => {
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

        eventsToFire.push(
          buildStateEnterEvent(instance, {
            fromState: null,
            toState: definition.initialState,
            transitionUuid: executionContext.transitionUuid,
            triggerEvent: null,
            triggerMetadata: structuredClone(input.triggerMetadata ?? {}),
            occurredAt: now,
          }),
        );

        await this.processOnEnterChain(instance, definition, executionContext, undefined, eventsToFire);

        return instance;
      });
    }

    return this.runWithObservers(async (eventsToFire) => {
      await this.instanceStore.create(instance);

      eventsToFire.push(
        buildStateEnterEvent(instance, {
          fromState: null,
          toState: definition.initialState,
          transitionUuid: randomUUID(),
          triggerEvent: null,
          triggerMetadata: structuredClone(input.triggerMetadata ?? {}),
          occurredAt: now,
        }),
      );

      return instance;
    });
  }

  async triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult> {
    await this.initialize();

    return this.runWithObservers(async (eventsToFire) => {
      const instance = await this.instanceStore.lockByUuid(input.workflowInstanceUuid);
      if (!instance) {
        throw new WorkflowInstanceNotFoundError(input.workflowInstanceUuid);
      }

      const { definition, compiled } = await this.definitionResolver.forInstance(instance);

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
          definitionVersion: this.definitionVersionOf(definition),
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

      this.applyTransition(instance, definition, eventResult.toState, now, executionContext);

      await this.instanceStore.update(instance);

      const errorMessage = extractErrorMessage(eventResult.outcome, eventResult.commandResults);

      let lastHistoryUuid = await this.historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: eventResult.fromState,
        eventName: input.eventName,
        toState: eventResult.toState,
        outcome: eventResult.outcome,
        errorMessage,
        commandResultsJson: eventResult.commandResults,
        triggerMetadata: structuredClone(input.triggerMetadata ?? {}),
        definitionVersion: this.definitionVersionOf(definition),
      });

      eventsToFire.push(
        buildStateEnterEvent(instance, {
          fromState: eventResult.fromState,
          toState: eventResult.toState,
          transitionUuid: executionContext.transitionUuid,
          triggerEvent: input.eventName,
          triggerMetadata: structuredClone(input.triggerMetadata ?? {}),
          occurredAt: now,
        }),
      );

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
  }

  async processExpiredWorkflows(input?: ProcessExpiredWorkflowsInput): Promise<ProcessExpiredWorkflowsResult> {
    await this.initialize();
    const limit = input?.limit ?? 100;
    assertPositiveSafeInteger(limit, "limit");
    const now = this.clock.now();
    let processed = 0;
    let rejected = 0;
    const businessFailed: Array<{ uuid: string; finalState: string }> = [];
    const failed: ProcessExpiredWorkflowsResult["failed"] = [];
    const parked: ProcessExpiredWorkflowsResult["parked"] = [];

    // Step 1: find expired instances (short-lived txn; locks released immediately).
    const expired = await this.transactionRunner.runInTransaction(async () => {
      return this.instanceStore.findExpired(limit, now);
    });

    // Step 2: process each instance in its own transaction.
    for (const staleInstance of expired) {
      let outcome: "transitioned" | "business-failed" | "rejected" | null = null;
      let finalState: string | null = null;
      try {
        await this.runWithObservers(async (eventsToFire) => {
          // Re-lock the instance fresh inside this transaction (locks from Step 1 were released).
          const instance = await this.instanceStore.lockByUuid(staleInstance.uuid);
          if (!instance) {
            // Instance disappeared (another worker deleted it); skip silently.
            return;
          }

          // Still due? Another worker may have processed it, or recorded a
          // failure that scheduled a later retry or parked it.
          if (!isTimeoutDue(instance, this.clock.now())) {
            return;
          }

          // Resolve definition + eventName from the FRESHLY-LOCKED state, not the pre-lock snapshot.
          const { definition } = await this.definitionResolver.forInstance(instance);
          const eventName = this.timeoutResolver.getTimeoutEventName(definition, instance.currentState);

          if (!eventName) {
            // No timeout event for this state; just clear the stale deadline.
            instance.expiresAt = null;
            instance.timeoutRetry = null;
            instance.version++;
            instance.updatedAt = this.clock.now();
            instance.definitionVersion = this.definitionVersionOf(definition);
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
        // This instance's work threw, so its observer events were never handed
        // over and none fire. Its writes are rolled back only if the runner
        // isolates them — a savepoint when nested, or the transaction it owns.
        const message = error instanceof Error ? error.message : String(error);
        const retry = await this.recordTimeoutFailure(staleInstance, message);
        if (retry) {
          failed.push({ uuid: staleInstance.uuid, error: message, attempts: retry.attempts, retryAt: retry.retryAt });
          if (retry.parkedAt) parked.push({ uuid: staleInstance.uuid, error: message });
        } else {
          failed.push({ uuid: staleInstance.uuid, error: message });
        }
      }
    }

    return { processed, rejected, businessFailed, failed, parked };
  }

  /**
   * Records a failed timeout attempt in its own transaction: schedules the next
   * retry with backoff, or parks the instance after `maxAttempts`. Records
   * nothing — returning `null` — when the instance no longer matches the
   * `snapshot` this sweep scanned (another worker or a user moved it, or it is
   * gone), or when recording itself fails; the next sweep then retries as usual.
   */
  private async recordTimeoutFailure(snapshot: WorkflowInstance, error: string): Promise<WorkflowTimeoutRetry | null> {
    try {
      return await this.transactionRunner.runInTransaction(async () => {
        const instance = await this.instanceStore.lockByUuid(snapshot.uuid);
        const now = this.clock.now();
        if (!instance || !matchesTimeoutSnapshot(instance, snapshot) || !isTimeoutDue(instance, now)) {
          return null;
        }
        const retry = this.timeoutRetryPolicy.next(instance.timeoutRetry, error, now);
        instance.timeoutRetry = retry;
        instance.version++;
        instance.updatedAt = now;
        await this.instanceStore.update(instance);
        return retry;
      });
    } catch (recordingError: unknown) {
      const message = recordingError instanceof Error ? recordingError.message : String(recordingError);
      console.warn(`[duraflows] could not record the timeout failure of instance "${snapshot.uuid}": ${message}`);
      return null;
    }
  }

  /**
   * Runs `work` in a transaction and delivers the observer events it queues
   * into `eventsToFire`: through the runner's `afterCommit` when it has one,
   * so they fire only once the enclosing transaction commits, otherwise as
   * soon as this `runInTransaction` call returns.
   */
  private async runWithObservers<T>(work: (eventsToFire: StateEnterEvent[]) => Promise<T>): Promise<T> {
    let undelivered: StateEnterEvent[] = [];
    const result = await this.transactionRunner.runInTransaction(async () => {
      const eventsToFire: StateEnterEvent[] = [];
      const value = await work(eventsToFire);
      undelivered = this.deferObservers(eventsToFire);
      return value;
    });
    await this.fireObservers(undelivered);
    return result;
  }

  /** Fires `events` in order; the observer registry contains observer errors. */
  private async fireObservers(events: readonly StateEnterEvent[]): Promise<void> {
    for (const event of events) {
      await this.observerRegistry.fireOnEnter(event);
    }
  }

  /**
   * Hands `events` to the runner's after-commit queue when it has one.
   * Returns the events the caller must fire itself after the transaction call
   * returns (all of them for a runner without `afterCommit`).
   */
  private deferObservers(events: StateEnterEvent[]): StateEnterEvent[] {
    const runner = this.transactionRunner;
    if (!runner.afterCommit || events.length === 0) {
      return events;
    }
    runner.afterCommit(() => this.fireObservers(events));
    return [];
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
      instance.timeoutRetry = null;
      instance.version++;
      instance.lastTransitionAt = now;
      instance.updatedAt = now;
      instance.definitionVersion = this.definitionVersionOf(definition);
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
        definitionVersion: this.definitionVersionOf(definition),
      });
      return "rejected";
    }

    const now = this.clock.now();
    this.applyTransition(instance, definition, result.toState, now, executionContext);

    await this.instanceStore.update(instance);

    const errorMessage = extractErrorMessage(result.outcome, result.commandResults);

    await this.historyStore.append({
      workflowInstanceUuid: instance.uuid,
      fromState: result.fromState,
      eventName,
      toState: result.toState,
      outcome: result.outcome,
      errorMessage,
      commandResultsJson: result.commandResults,
      triggerMetadata: { source: "timeout" },
      definitionVersion: this.definitionVersionOf(definition),
    });

    eventsToFire.push(
      buildStateEnterEvent(instance, {
        fromState: result.fromState,
        toState: result.toState,
        transitionUuid: executionContext.transitionUuid,
        triggerEvent: eventName,
        triggerMetadata: { source: "timeout" },
        occurredAt: now,
      }),
    );

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

  /**
   * Advances the in-memory instance onto `toState`: bumps version and
   * timestamps, overlays the target state's declared context on top of whatever
   * the commands mutated, and recomputes the timeout deadline. `executionContext`
   * is kept in step so a following onEnter hop's commands observe the merged
   * context. Persisting the result is the caller's job — this touches memory only.
   *
   * `applyDeclaredContext: false` persists the commands' context as-is, for an
   * onEnter chain that ends in the state it was already in.
   */
  private applyTransition(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    toState: string,
    now: Date,
    executionContext: WorkflowExecutionContext,
    { applyDeclaredContext = true }: { applyDeclaredContext?: boolean } = {},
  ): void {
    instance.currentState = toState;
    instance.version++;
    instance.lastTransitionAt = now;
    instance.updatedAt = now;
    instance.definitionVersion = this.definitionVersionOf(definition);

    const stateDef = definition.states[toState];
    instance.context = {
      ...executionContext.context,
      ...(applyDeclaredContext ? structuredClone(stateDef?.context ?? {}) : {}),
    };
    executionContext.context = { ...instance.context };

    instance.expiresAt = this.timeoutResolver.computeDeadline(definition, toState, now);
    instance.timeoutRetry = null;
  }

  /** The version label of a registered definition; omitted means 1. */
  private definitionVersionOf(definition: WorkflowDefinition): number {
    return definition.version ?? 1;
  }

  private async processOnEnterChain(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    executionContext: WorkflowExecutionContext,
    subject: unknown,
    eventsToFire: StateEnterEvent[],
  ): Promise<{ commandResults: CommandResult[]; lastHistoryUuid: string | null; chainOutcome: "success" | "failure" }> {
    const allCommandResults: CommandResult[] = [];
    let lastHistoryUuid: string | null = null;

    // Each hop is applied before the next state's commands run, so those
    // commands see the context of the state they are running in, and each
    // observer snapshot holds the context at its own entry.
    const chainResult = await this.onEnterExecutor.executeChain(
      definition,
      instance.currentState,
      instance.uuid,
      subject,
      executionContext,
      this.maxOnEnterDepth,
      async (hop) => {
        const now = this.clock.now();
        // A hop that stays put ends the chain in a state that was already
        // entered: its declared context was applied then, before its onEnter
        // commands ran, so re-applying it would overwrite what they wrote.
        this.applyTransition(instance, definition, hop.toState, now, executionContext, {
          applyDeclaredContext: hop.toState !== hop.fromState,
        });

        await this.instanceStore.update(instance);

        const errorMessage = extractErrorMessage(hop.outcome, hop.commandResults);

        lastHistoryUuid = await this.historyStore.append({
          workflowInstanceUuid: instance.uuid,
          fromState: hop.fromState,
          eventName: "onEnter",
          toState: hop.toState,
          outcome: hop.outcome,
          errorMessage,
          commandResultsJson: hop.commandResults,
          triggerMetadata: { source: "onEnter" },
          definitionVersion: this.definitionVersionOf(definition),
        });

        eventsToFire.push(
          buildStateEnterEvent(instance, {
            fromState: hop.fromState,
            toState: hop.toState,
            transitionUuid: hop.transitionUuid,
            triggerEvent: "onEnter",
            triggerMetadata: { source: "onEnter" },
            occurredAt: now,
          }),
        );

        allCommandResults.push(...hop.commandResults);
      },
    );

    return { commandResults: allCommandResults, lastHistoryUuid, chainOutcome: chainResult.outcome };
  }

  async getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]> {
    const instance = await this.instanceStore.findByUuid(input.workflowInstanceUuid);
    if (!instance) {
      throw new WorkflowInstanceNotFoundError(input.workflowInstanceUuid);
    }

    const { definition } = await this.definitionResolver.forInstance(instance);
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

  /**
   * Instances parked after `timeoutRetry.maxAttempts` consecutive failed timeout
   * attempts, oldest-parked first. Their `timeoutRetry` carries the attempt
   * count, the last error, and when they were parked.
   */
  async findParkedTimeouts(input?: FindParkedTimeoutsInput): Promise<WorkflowInstance[]> {
    const limit = input?.limit ?? 100;
    assertPositiveSafeInteger(limit, "limit");
    return this.instanceStore.findParkedTimeouts({ limit, workflowName: input?.workflowName });
  }

  /**
   * Every stored version of `workflowName`, oldest first, with how many
   * non-terminal instances are still stamped with it — use it to decide when
   * an old version has drained and its commands can be deleted. A plain read;
   * requires a definition store.
   */
  async listDefinitionVersions(workflowName: string): Promise<DefinitionVersionSummary[]> {
    if (!this.definitionStore) {
      throw new WorkflowError("listDefinitionVersions requires a definition store");
    }
    const summaries: DefinitionVersionSummary[] = [];
    for (const stored of await this.definitionStore.listVersions(workflowName)) {
      summaries.push({
        version: stored.version,
        contentHash: stored.contentHash,
        registeredAt: stored.registeredAt,
        activeInstances: await countActiveInstances(this.instanceStore, stored),
      });
    }
    return summaries;
  }

  /**
   * Clears an instance's timeout retry state — un-parking it — so the next
   * `processExpiredWorkflows` retries its timeout if the deadline has passed.
   * An instance without retry state is returned unchanged.
   */
  async rearmTimeout(workflowInstanceUuid: string): Promise<WorkflowInstance> {
    await this.initialize();
    return this.transactionRunner.runInTransaction(async () => {
      const instance = await this.instanceStore.lockByUuid(workflowInstanceUuid);
      if (!instance) {
        throw new WorkflowInstanceNotFoundError(workflowInstanceUuid);
      }
      if (instance.timeoutRetry === null) {
        return instance;
      }
      instance.timeoutRetry = null;
      instance.version++;
      instance.updatedAt = this.clock.now();
      await this.instanceStore.update(instance);
      return instance;
    });
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
