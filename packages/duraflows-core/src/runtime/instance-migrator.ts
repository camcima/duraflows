import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "../types/definition.js";
import type { WorkflowInstanceStore, WorkflowHistoryStore, WorkflowClock } from "../types/persistence.js";
import type { MigrateInstancesInput, MigrateInstancesResult, WorkflowInstance } from "../types/runtime.js";
import type { StateEnterEvent } from "../types/observer.js";
import type { DefinitionResolver } from "./definition-resolver.js";
import type { TimeoutResolver } from "../execution/timeout-resolver.js";
import { buildStateEnterEvent } from "./state-enter-event.js";
import { deepFreeze } from "../util/deep-freeze.js";
import { assertPositiveSafeInteger } from "../util/assert.js";
import { InvalidArgumentError, WorkflowError } from "../errors/index.js";

/** Candidates fetched per findInstanceUuids call. */
const PAGE_SIZE = 100;

export interface InstanceMigratorDeps {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  clock: WorkflowClock;
  definitionResolver: DefinitionResolver;
  timeoutResolver: TimeoutResolver;
  /** Runs `work` in a transaction and delivers the observer events it queues once it commits. */
  runWithObservers: <T>(work: (eventsToFire: StateEnterEvent[]) => Promise<T>) => Promise<T>;
}

type Plan =
  | { kind: "migrate"; fromState: string; toState: string; context: Record<string, unknown> }
  | { kind: "skip"; reason: string };

/**
 * Relabels instances from one stored definition version to another. No
 * commands, guards or onEnter run; each move is one transaction that updates
 * the instance, appends a `$migrated` history row and queues one observer event.
 */
export class InstanceMigrator {
  constructor(private readonly deps: InstanceMigratorDeps) {}

  async migrate(input: MigrateInstancesInput): Promise<MigrateInstancesResult> {
    assertPositiveSafeInteger(input.fromVersion, "fromVersion");
    assertPositiveSafeInteger(input.toVersion, "toVersion");
    if (input.fromVersion === input.toVersion) {
      throw new InvalidArgumentError("fromVersion and toVersion must differ");
    }
    if (input.limit !== undefined) {
      assertPositiveSafeInteger(input.limit, "limit");
    }
    const { definition: target } = await this.deps.definitionResolver.forVersion(input.workflowName, input.toVersion);
    for (const [from, to] of Object.entries(input.stateMapping ?? {})) {
      if (!Object.hasOwn(target.states, to)) {
        throw new InvalidArgumentError(
          `stateMapping maps "${from}" to "${to}", which is not a state of version ${input.toVersion}`,
        );
      }
      if (target.states[to].onEnter) {
        throw new InvalidArgumentError(
          `stateMapping maps "${from}" to "${to}", which has an onEnter in version ${input.toVersion}; ` +
            "migration never runs onEnter",
        );
      }
    }
    if (input.instanceUuids === undefined && !this.deps.instanceStore.findInstanceUuids) {
      throw new WorkflowError(
        "migrateInstances without instanceUuids requires an instance store that implements findInstanceUuids",
      );
    }

    const result: MigrateInstancesResult = { dryRun: input.dryRun === true, migrated: [], skipped: [], failed: [] };
    for await (const uuid of this.candidates(input)) {
      try {
        const plan = result.dryRun
          ? this.plan(await this.deps.instanceStore.findByUuid(uuid), input, target)
          : await this.deps.runWithObservers(async (eventsToFire) => {
              const instance = await this.deps.instanceStore.lockByUuid(uuid);
              const planned = this.plan(instance, input, target);
              if (planned.kind === "migrate") {
                await this.apply(instance!, planned, input, target, eventsToFire);
              }
              return planned;
            });
        if (plan.kind === "migrate") {
          result.migrated.push({ uuid, fromState: plan.fromState, toState: plan.toState });
        } else {
          result.skipped.push({ uuid, reason: plan.reason });
        }
      } catch (error: unknown) {
        result.failed.push({ uuid, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  /** Explicit UUIDs (de-duplicated, in order) or pages from findInstanceUuids, capped by `limit`. */
  private async *candidates(input: MigrateInstancesInput): AsyncGenerator<string> {
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    let examined = 0;
    if (input.instanceUuids !== undefined) {
      for (const uuid of new Set(input.instanceUuids)) {
        if (examined >= limit) return;
        examined++;
        yield uuid;
      }
      return;
    }
    const store = this.deps.instanceStore;
    let afterUuid: string | undefined;
    while (examined < limit) {
      const page = await store.findInstanceUuids!({
        workflowName: input.workflowName,
        definitionVersion: input.fromVersion,
        limit: Math.min(PAGE_SIZE, limit - examined),
        afterUuid,
      });
      if (page.length === 0) return;
      for (const uuid of page) {
        examined++;
        yield uuid;
      }
      afterUuid = page[page.length - 1];
    }
  }

  private plan(instance: WorkflowInstance | null, input: MigrateInstancesInput, target: WorkflowDefinition): Plan {
    if (!instance) return { kind: "skip", reason: "not found" };
    if (instance.workflowName !== input.workflowName) {
      return { kind: "skip", reason: `belongs to workflow ${instance.workflowName}` };
    }
    if (instance.definitionVersion === null) return { kind: "skip", reason: "unstamped" };
    if (instance.definitionVersion !== input.fromVersion) {
      return { kind: "skip", reason: `on version ${instance.definitionVersion}, not ${input.fromVersion}` };
    }
    const fromState = instance.currentState;
    const mapping = input.stateMapping;
    let toState: string;
    if (mapping !== undefined && Object.hasOwn(mapping, fromState)) {
      toState = mapping[fromState];
    } else if (Object.hasOwn(target.states, fromState)) {
      if (target.states[fromState].onEnter) {
        return { kind: "skip", reason: `state ${fromState} has an onEnter in version ${input.toVersion}` };
      }
      toState = fromState;
    } else {
      return {
        kind: "skip",
        reason: `state ${fromState} has no mapping and does not exist in version ${input.toVersion}`,
      };
    }
    return { kind: "migrate", fromState, toState, context: this.transformedContext(instance, input) };
  }

  private transformedContext(instance: WorkflowInstance, input: MigrateInstancesInput): Record<string, unknown> {
    if (!input.transformContext) return instance.context;
    const transformed = input.transformContext(
      structuredClone(instance.context),
      deepFreeze(structuredClone(instance)),
    );
    if (transformed === null || typeof transformed !== "object" || Array.isArray(transformed)) {
      throw new InvalidArgumentError("transformContext must return a plain object");
    }
    return JSON.parse(JSON.stringify(transformed)) as Record<string, unknown>;
  }

  private async apply(
    instance: WorkflowInstance,
    plan: Extract<Plan, { kind: "migrate" }>,
    input: MigrateInstancesInput,
    target: WorkflowDefinition,
    eventsToFire: StateEnterEvent[],
  ): Promise<void> {
    const now = this.deps.clock.now();
    instance.currentState = plan.toState;
    instance.definitionVersion = input.toVersion;
    instance.context = plan.context;
    // Elapsed time is preserved: the deadline counts from the last real transition.
    instance.expiresAt = this.deps.timeoutResolver.computeDeadline(target, plan.toState, instance.lastTransitionAt);
    instance.timeoutRetry = null;
    instance.version++;
    instance.updatedAt = now;
    await this.deps.instanceStore.update(instance);

    const triggerMetadata = { source: "migration", fromVersion: input.fromVersion, toVersion: input.toVersion };
    await this.deps.historyStore.append({
      workflowInstanceUuid: instance.uuid,
      fromState: plan.fromState,
      eventName: "$migrated",
      toState: plan.toState,
      outcome: "success",
      commandResultsJson: [],
      triggerMetadata: { ...triggerMetadata },
      definitionVersion: input.toVersion,
    });
    eventsToFire.push(
      buildStateEnterEvent(instance, {
        fromState: plan.fromState,
        toState: plan.toState,
        transitionUuid: randomUUID(),
        triggerEvent: "$migrated",
        triggerMetadata: { ...triggerMetadata },
        occurredAt: now,
      }),
    );
  }
}
