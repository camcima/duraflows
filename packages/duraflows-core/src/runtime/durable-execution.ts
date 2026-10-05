import { extractErrorMessage } from "./error-message.js";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowDefinition, WorkflowCommandRef } from "../types/definition.js";
import type { CommandResult, WorkflowExecutionContext, WorkflowInstance } from "../types/runtime.js";
import type {
  WorkflowClock,
  WorkflowHistoryStore,
  WorkflowInstanceStore,
  WorkflowTransactionRunner,
} from "../types/persistence.js";
import type {
  DurableExecutionOptions,
  DurableWorkflowExecution,
  EnqueueWorkflowEventInput,
  ProcessPendingExecutionsInput,
  ProcessPendingExecutionsResult,
  WorkflowExecutionStore,
} from "../types/durable.js";
import type { WorkflowCommandRegistry } from "../registry/command-registry.js";
import type { WorkflowGuardRegistry } from "../registry/guard-registry.js";
import type { StateEnterEvent } from "../types/observer.js";
import { CommandExecutor } from "../execution/command-executor.js";
import { EventExecutor } from "../execution/event-executor.js";
import { OnEnterExecutor } from "../execution/on-enter-executor.js";
import { WorkflowCompiler } from "../compilation/workflow-compiler.js";
import { TimeoutResolver } from "../execution/timeout-resolver.js";
import { deepFreeze } from "../util/deep-freeze.js";
import { assertPositiveSafeInteger } from "../util/assert.js";
import { buildStateEnterEvent } from "./state-enter-event.js";
import { referencedNames } from "./definition-executability.js";
import {
  describeThrown,
  ExecutionLeaseLostError,
  IdempotencyConflictError,
  InvalidArgumentError,
  InvalidEventError,
  WorkflowError,
  WorkflowInstanceBusyError,
  WorkflowInstanceNotFoundError,
} from "../errors/index.js";

interface Dependencies {
  store: WorkflowExecutionStore;
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  transactionRunner: WorkflowTransactionRunner;
  commandRegistry: WorkflowCommandRegistry;
  guardRegistry?: WorkflowGuardRegistry;
  clock: WorkflowClock;
  maxOnEnterDepth: number;
  options?: DurableExecutionOptions;
  initialize(): Promise<void>;
  resolve(instance: WorkflowInstance): Promise<WorkflowDefinition>;
  runWithObservers<T>(work: (events: StateEnterEvent[]) => Promise<T>): Promise<T>;
}

function snapshot<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    throw new WorkflowError("Durable execution values must be JSON-serializable", error);
  }
}

// Reject lossy inputs rather than silently dropping functions, undefined, Dates or class state.
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new InvalidArgumentError("Durable inputs must be JSON values");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null)
    throw new InvalidArgumentError("Durable inputs must be plain JSON objects");
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJson(item, ancestors);
  ancestors.delete(value);
}

function identity(input: EnqueueWorkflowEventInput): void {
  for (const value of [
    input.idempotencyKey,
    ...(input.idempotencyFingerprint === undefined ? [] : [input.idempotencyFingerprint]),
  ]) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.includes("\0") ||
      Buffer.byteLength(value) > 256 ||
      Buffer.from(value).toString() !== value
    ) {
      throw new InvalidArgumentError(
        "Durable keys/fingerprints must be nonblank valid Unicode strings of at most 256 UTF-8 bytes without NUL",
      );
    }
  }
}

function transitionUuid(uuid: string, hop: number): string {
  const hex = createHash("sha256").update(`${uuid}:${hop}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

class PendingCommand extends Error {
  constructor(
    readonly ref: WorkflowCommandRef,
    readonly context: WorkflowExecutionContext,
  ) {
    super("Command needs execution");
  }
}

/** Reconstructs the declarative plan using recorded results; never calls a registered handler. */
class JournalExecutor extends CommandExecutor {
  private cursor = 0;
  constructor(
    registry: WorkflowCommandRegistry,
    private readonly execution: DurableWorkflowExecution,
  ) {
    super(registry);
  }
  override async execute(commands: WorkflowCommandRef[], _subject: unknown, context: WorkflowExecutionContext) {
    const results: CommandResult[] = [];
    for (const ref of commands) {
      const checkpoint = this.execution.journal[this.cursor++];
      if (!checkpoint)
        throw new PendingCommand(ref, {
          ...context,
          context: snapshot(context.context),
          commandMetadata: deepFreeze(snapshot(ref.metadata ?? {})),
        });
      for (const key of Object.keys(context.context)) delete context.context[key];
      for (const [key, value] of Object.entries(snapshot(checkpoint.context)))
        Object.defineProperty(context.context, key, { value, enumerable: true, configurable: true, writable: true });
      results.push(checkpoint.result);
      if (!checkpoint.result.ok && !this.execution.bestEffortCommands.includes(ref.name))
        return { outcome: "failure" as const, commandResults: results };
    }
    return { outcome: "success" as const, commandResults: results };
  }
}

interface Hop {
  fromState: string;
  toState: string;
  transitionUuid: string;
  eventName: string;
  outcome: "success" | "failure";
  commandResults: CommandResult[];
  context: Record<string, unknown>;
}
interface Plan {
  hops: Hop[];
  outcome: "success" | "failure";
  toState: string;
}

/** Internal engine used by WorkflowRuntime; all mutable ownership decisions hold the instance lock. */
export class DurableExecutionRunner {
  private readonly policy: Required<DurableExecutionOptions>;
  constructor(private readonly deps: Dependencies) {
    this.policy = {
      leaseDurationMs: 30_000,
      initialDelayMs: 1_000,
      maxDelayMs: 3_600_000,
      maxAttempts: 10,
      ...deps.options,
    };
    for (const [key, value] of Object.entries(this.policy)) assertPositiveSafeInteger(value, key);
    if (this.policy.maxDelayMs < this.policy.initialDelayMs)
      throw new InvalidArgumentError("maxDelayMs must be at least initialDelayMs");
  }

  async enqueue(input: EnqueueWorkflowEventInput): Promise<DurableWorkflowExecution> {
    identity(input);
    assertJson(input.subject ?? null);
    assertJson(input.triggerMetadata ?? {});
    input = snapshot(input);
    await this.deps.initialize();
    return this.deps.runWithObservers(async () => {
      const instance = await this.deps.instanceStore.lockByUuid(input.workflowInstanceUuid);
      if (!instance) throw new WorkflowInstanceNotFoundError(input.workflowInstanceUuid);
      const existing = await this.deps.store.findByKey(instance.uuid, input.idempotencyKey);
      if (existing) {
        if (existing.eventName !== input.eventName || existing.idempotencyFingerprint !== input.idempotencyFingerprint)
          throw new IdempotencyConflictError(instance.uuid);
        return existing;
      }
      if (await this.deps.store.findActive(instance.uuid)) throw new WorkflowInstanceBusyError(instance.uuid);
      const definition = snapshot(await this.deps.resolve(instance));
      const state = Object.hasOwn(definition.states, instance.currentState)
        ? definition.states[instance.currentState]
        : undefined;
      if (!state?.events || !Object.hasOwn(state.events, input.eventName))
        throw new InvalidEventError(instance.uuid, instance.currentState, input.eventName);
      const event = state.events[input.eventName];
      const now = this.deps.clock.now().toISOString();
      const execution: DurableWorkflowExecution = {
        uuid: randomUUID(),
        workflowInstanceUuid: instance.uuid,
        workflowName: instance.workflowName,
        eventName: input.eventName,
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: input.idempotencyFingerprint,
        status: "pending",
        revision: 0,
        definition,
        bestEffortCommands: referencedNames(definition).commands.filter(
          (name) => this.deps.commandRegistry.get(name).bestEffort,
        ),
        instanceVersion: instance.version,
        fromState: instance.currentState,
        initialContext: snapshot(instance.context),
        metadata: snapshot(instance.metadata),
        subject: input.subject,
        triggerMetadata: input.triggerMetadata ?? {},
        journal: [],
        result: null,
        attempts: 0,
        lastError: null,
        availableAt: now,
        leaseToken: null,
        leaseUntil: null,
        createdAt: now,
        updatedAt: now,
        policy: this.policy,
        maxOnEnterDepth: this.deps.maxOnEnterDepth,
      };
      if (event.guard) {
        if (!this.deps.guardRegistry) throw new WorkflowError("Durable event requires a guard registry");
        const passed = await this.deps.guardRegistry
          .get(event.guard.name)
          .evaluate(deepFreeze(snapshot(input.subject ?? null)), {
            ...this.context(execution),
            toState: event.targetState ?? instance.currentState,
            context: deepFreeze(snapshot(instance.context)),
            commandMetadata: deepFreeze(snapshot(event.guard.metadata ?? {})),
          });
        if (!passed) {
          execution.rejectedBy = event.guard.name;
          const historyUuid = await this.deps.historyStore.append({
            workflowInstanceUuid: instance.uuid,
            fromState: instance.currentState,
            toState: instance.currentState,
            eventName: input.eventName,
            outcome: "guard-rejected",
            rejectedBy: event.guard.name,
            commandResultsJson: [],
            triggerMetadata: execution.triggerMetadata,
            definitionVersion: definition.version ?? 1,
          });
          execution.status = "completed";
          execution.result = {
            outcome: "guard-rejected",
            fromState: instance.currentState,
            toState: instance.currentState,
            commandResults: [],
            historyUuid,
            rejectedBy: event.guard.name,
          };
        }
      }
      await this.deps.store.create(execution);
      return snapshot(execution);
    });
  }

  async process(input: ProcessPendingExecutionsInput = {}): Promise<ProcessPendingExecutionsResult> {
    if (!this.deps.transactionRunner.isTransactionActive || this.deps.transactionRunner.isTransactionActive())
      throw new WorkflowError(
        "Durable workers require ambient-transaction detection and must run outside a transaction",
      );
    const limit = input.limit ?? 100;
    assertPositiveSafeInteger(limit, "limit");
    const result: ProcessPendingExecutionsResult = {
      processed: 0,
      completed: [],
      progressed: [],
      retrying: [],
      parked: [],
      skipped: [],
      failed: [],
    };
    const candidates = await this.deps.store.findDue(limit, this.deps.clock.now());
    for (const candidate of candidates) {
      let claimed: DurableWorkflowExecution | null = null;
      try {
        claimed = await this.claim(candidate);
        if (!claimed) {
          result.skipped.push(candidate.uuid);
          continue;
        }
        result.processed++;
        if (claimed.status === "parked") {
          result.parked.push(claimed.uuid);
          continue;
        }
        let pending: PendingCommand;
        try {
          const plan = await this.plan(claimed);
          await this.owned(claimed, (current, instance, events) => this.finish(current, instance, plan, events));
          result.completed.push(claimed.uuid);
          continue;
        } catch (error) {
          if (!(error instanceof PendingCommand)) throw error;
          pending = error;
        }
        if (pending.ref.transactional) {
          await this.owned(claimed, async (current, instance, events) => {
            const completed = await this.invoke(claimed!, pending);
            await this.checkpoint(
              (await this.deps.store.findByUuid(current.uuid))!,
              instance,
              completed,
              pending,
              events,
            );
          });
        } else {
          const completed = await this.invoke(claimed, pending);
          await this.owned(claimed, (current, instance, events) =>
            this.checkpoint(current, instance, completed, pending, events),
          );
        }
        const updated = (await this.deps.store.findByUuid(claimed.uuid))!;
        if (updated.status === "completed") result.completed.push(claimed.uuid);
        else if (updated.status === "parked") result.parked.push(claimed.uuid);
        else result.progressed.push(claimed.uuid);
      } catch (error) {
        if (error instanceof ExecutionLeaseLostError) {
          result.skipped.push(candidate.uuid);
          continue;
        }
        if (!claimed) {
          result.failed.push({ uuid: candidate.uuid, error: describeThrown(error) });
          continue;
        }
        try {
          const status = await this.owned(claimed, async (current) => {
            current.lastError = describeThrown(error);
            current.status = current.attempts >= current.policy.maxAttempts ? "parked" : "pending";
            const delay = Math.min(
              current.policy.maxDelayMs,
              current.policy.initialDelayMs * 2 ** Math.min(current.attempts - 1, 52),
            );
            current.availableAt = new Date(this.deps.clock.now().getTime() + delay).toISOString();
            current.leaseToken = null;
            current.leaseUntil = null;
            await this.save(current);
            return current.status;
          });
          result[status === "parked" ? "parked" : "retrying"].push(claimed.uuid);
        } catch (failure) {
          result.failed.push({ uuid: candidate.uuid, error: describeThrown(failure) });
        }
      }
    }
    return result;
  }

  async control(uuid: string, action: "retry" | "cancel"): Promise<DurableWorkflowExecution> {
    const hint = await this.deps.store.findByUuid(uuid);
    if (!hint) throw new InvalidArgumentError("Durable execution not found");
    return this.deps.transactionRunner.runInTransaction(async () => {
      await this.deps.instanceStore.lockByUuid(hint.workflowInstanceUuid);
      const current = await this.deps.store.findByUuid(uuid);
      if (!current) throw new InvalidArgumentError("Durable execution not found");
      if (action === "retry") {
        if (current.status !== "parked") throw new InvalidArgumentError("Only parked executions can be retried");
        current.status = "pending";
        current.attempts = 0;
        current.availableAt = this.deps.clock.now().toISOString();
      } else {
        if (
          current.status === "completed" ||
          current.status === "cancelled" ||
          (current.leaseUntil !== null && new Date(current.leaseUntil) > this.deps.clock.now())
        )
          throw new InvalidArgumentError("Cannot cancel a completed or actively leased execution");
        current.status = "cancelled";
      }
      current.leaseToken = null;
      current.leaseUntil = null;
      await this.save(current);
      return current;
    });
  }

  private async claim(hint: DurableWorkflowExecution): Promise<DurableWorkflowExecution | null> {
    return this.deps.transactionRunner.runInTransaction(async () => {
      const instance = await this.deps.instanceStore.lockByUuid(hint.workflowInstanceUuid);
      const current = await this.deps.store.findByUuid(hint.uuid);
      const now = this.deps.clock.now();
      if (
        !instance ||
        !current ||
        !["pending", "running"].includes(current.status) ||
        new Date(current.availableAt) > now ||
        (current.leaseUntil !== null && new Date(current.leaseUntil) > now)
      )
        return null;
      if (current.attempts >= current.policy.maxAttempts) {
        current.status = "parked";
        current.lastError = "Command lease expired at the attempt limit";
        current.leaseToken = null;
        current.leaseUntil = null;
        await this.save(current);
        return current;
      }
      current.status = "running";
      current.leaseToken = randomUUID();
      current.leaseUntil = new Date(now.getTime() + current.policy.leaseDurationMs).toISOString();
      current.attempts++;
      if (instance.version !== current.instanceVersion)
        throw new WorkflowError("Instance changed during durable execution");
      await this.save(current);
      return current;
    });
  }

  private async owned<T>(
    claim: DurableWorkflowExecution,
    work: (current: DurableWorkflowExecution, instance: WorkflowInstance, events: StateEnterEvent[]) => Promise<T>,
  ): Promise<T> {
    return this.deps.runWithObservers(async (events) => {
      const instance = await this.deps.instanceStore.lockByUuid(claim.workflowInstanceUuid);
      const current = await this.deps.store.findByUuid(claim.uuid);
      if (
        !instance ||
        !current ||
        current.status !== "running" ||
        current.leaseToken !== claim.leaseToken ||
        current.leaseUntil === null ||
        new Date(current.leaseUntil) <= this.deps.clock.now()
      )
        throw new ExecutionLeaseLostError();
      if (instance.version !== current.instanceVersion)
        throw new WorkflowError("Instance changed during durable execution");
      return work(current, instance, events);
    });
  }

  private async invoke(claim: DurableWorkflowExecution, pending: PendingCommand): Promise<CommandResult> {
    const command = this.deps.commandRegistry.get(pending.ref.name);
    const commandId = String(claim.journal.length);
    const context: WorkflowExecutionContext = {
      ...pending.context,
      durable: {
        executionUuid: claim.uuid,
        commandId,
        idempotencyKey: `${claim.uuid}:${commandId}`,
        attempt: claim.attempts,
        heartbeat: async () => {
          await this.owned(claim, async (current) => {
            current.leaseUntil = new Date(
              this.deps.clock.now().getTime() + current.policy.leaseDurationMs,
            ).toISOString();
            await this.save(current);
          });
        },
      },
    };
    try {
      return await command.execute(deepFreeze(snapshot(claim.subject ?? null)), context);
    } catch (error) {
      if (!claim.bestEffortCommands.includes(pending.ref.name)) throw error;
      return { ok: false, code: "BEST_EFFORT_THROWN", message: describeThrown(error) };
    }
  }

  private async checkpoint(
    current: DurableWorkflowExecution,
    instance: WorkflowInstance,
    result: CommandResult,
    pending: PendingCommand,
    events: StateEnterEvent[],
  ): Promise<void> {
    if (current.leaseUntil === null || new Date(current.leaseUntil) <= this.deps.clock.now())
      throw new ExecutionLeaseLostError();
    if (!result || typeof result.ok !== "boolean") throw new WorkflowError("Command must return a CommandResult");
    const checkpoint = snapshot({
      id: String(current.journal.length),
      name: pending.ref.name,
      result,
      context: pending.context.context,
      attempts: current.attempts,
      completedAt: this.deps.clock.now().toISOString(),
    });
    current.journal.push(checkpoint);
    current.attempts = 0;
    current.lastError = null;
    let plan: Plan;
    try {
      plan = await this.plan(current);
    } catch (error) {
      if (error instanceof PendingCommand) current.status = "pending";
      else {
        current.status = "parked";
        current.lastError = describeThrown(error);
      }
      current.availableAt = this.deps.clock.now().toISOString();
      current.leaseToken = null;
      current.leaseUntil = null;
      await this.save(current);
      return;
    }
    await this.finish(current, instance, plan, events);
  }

  private context(execution: DurableWorkflowExecution): WorkflowExecutionContext {
    return {
      context: snapshot(execution.initialContext),
      metadata: deepFreeze(snapshot(execution.metadata)),
      commandMetadata: deepFreeze({}),
      triggerMetadata: deepFreeze(snapshot(execution.triggerMetadata)),
      now: new Date(execution.createdAt),
      fromState: execution.fromState,
      toState: execution.fromState,
      transitionUuid: transitionUuid(execution.uuid, 0),
    };
  }

  private async plan(execution: DurableWorkflowExecution): Promise<Plan> {
    const definition = snapshot(execution.definition);
    const event = definition.states[execution.fromState].events![execution.eventName];
    delete event.guard; // Evaluated exactly once at acceptance, never during recovery.
    const commands = new JournalExecutor(this.deps.commandRegistry, execution);
    const context = { ...this.context(execution), toState: event.targetState ?? execution.fromState };
    const result = await new EventExecutor(commands).execute(
      new WorkflowCompiler().compile(definition),
      execution.fromState,
      execution.eventName,
      execution.workflowInstanceUuid,
      execution.subject,
      context,
    );
    const hops: Hop[] = [];
    const record = (hop: Omit<Hop, "context">, applyContext: boolean) => {
      context.context = {
        ...context.context,
        ...(applyContext ? snapshot(definition.states[hop.toState].context ?? {}) : {}),
      };
      hops.push({ ...hop, context: snapshot(context.context) });
    };
    record(
      {
        fromState: result.fromState,
        toState: result.toState,
        outcome: result.outcome as "success" | "failure",
        commandResults: result.commandResults,
        transitionUuid: context.transitionUuid,
        eventName: execution.eventName,
      },
      true,
    );
    let counter = 1;
    const chain = await new OnEnterExecutor(commands, () => transitionUuid(execution.uuid, counter++)).executeChain(
      definition,
      result.toState,
      execution.workflowInstanceUuid,
      execution.subject,
      context,
      execution.maxOnEnterDepth,
      async (hop) => {
        record({ ...hop, eventName: "onEnter" }, hop.fromState !== hop.toState);
      },
    );
    return {
      hops,
      toState: chain.finalState,
      outcome: result.outcome === "failure" || chain.outcome === "failure" ? "failure" : "success",
    };
  }

  private async finish(
    current: DurableWorkflowExecution,
    instance: WorkflowInstance,
    plan: Plan,
    events: StateEnterEvent[],
  ): Promise<void> {
    let historyUuid = "";
    for (const hop of plan.hops) {
      const now = this.deps.clock.now();
      instance.currentState = hop.toState;
      instance.context = hop.context;
      instance.version++;
      instance.definitionVersion = current.definition.version ?? 1;
      instance.updatedAt = now;
      instance.lastTransitionAt = now;
      instance.timeoutRetry = null;
      instance.expiresAt = new TimeoutResolver().computeDeadline(current.definition, hop.toState, now);
      await this.deps.instanceStore.update(instance);
      const triggerMetadata = hop.eventName === "onEnter" ? { source: "onEnter" } : current.triggerMetadata;
      historyUuid = await this.deps.historyStore.append({
        workflowInstanceUuid: instance.uuid,
        fromState: hop.fromState,
        toState: hop.toState,
        eventName: hop.eventName,
        outcome: hop.outcome,
        errorMessage: extractErrorMessage(hop.outcome, hop.commandResults),
        commandResultsJson: hop.commandResults,
        triggerMetadata,
        definitionVersion: instance.definitionVersion,
      });
      events.push(
        buildStateEnterEvent(instance, {
          fromState: hop.fromState,
          toState: hop.toState,
          transitionUuid: hop.transitionUuid,
          triggerEvent: hop.eventName,
          triggerMetadata,
          occurredAt: now,
        }),
      );
    }
    current.status = "completed";
    current.leaseToken = null;
    current.leaseUntil = null;
    current.result = {
      outcome: plan.outcome,
      fromState: current.fromState,
      toState: plan.toState,
      commandResults: current.journal.map((entry) => entry.result),
      historyUuid,
    };
    await this.save(current);
  }

  private async save(execution: DurableWorkflowExecution): Promise<void> {
    execution.revision++;
    execution.updatedAt = this.deps.clock.now().toISOString();
    await this.deps.store.update(execution);
  }
}
