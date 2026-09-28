import { randomUUID } from "node:crypto";
import type { WorkflowDefinition } from "../types/definition.js";
import type { WorkflowInstanceStore, WorkflowHistoryStore, WorkflowClock } from "../types/persistence.js";
import type { MigrateInstancesInput, MigrateInstancesResult, WorkflowInstance } from "../types/runtime.js";
import type { StateEnterEvent } from "../types/observer.js";
import type { WorkflowCommandRegistry } from "../registry/command-registry.js";
import type { WorkflowGuardRegistry } from "../registry/guard-registry.js";
import type { DefinitionResolver } from "./definition-resolver.js";
import type { TimeoutResolver } from "../execution/timeout-resolver.js";
import { buildStateEnterEvent } from "./state-enter-event.js";
import { referencedNames } from "./definition-executability.js";
import { deepFreeze } from "../util/deep-freeze.js";
import { assertPositiveSafeInteger } from "../util/assert.js";
import { describeThrown, InvalidArgumentError, MigrationInterruptedError, WorkflowError } from "../errors/index.js";

/** Candidates fetched per findInstanceUuids call. */
const PAGE_SIZE = 100;

export interface InstanceMigratorDeps {
  instanceStore: WorkflowInstanceStore;
  historyStore: WorkflowHistoryStore;
  clock: WorkflowClock;
  definitionResolver: DefinitionResolver;
  timeoutResolver: TimeoutResolver;
  commandRegistry: WorkflowCommandRegistry;
  guardRegistry?: WorkflowGuardRegistry;
  /** Runs `work` in a transaction and delivers the observer events it queues once it commits. */
  runWithObservers: <T>(work: (eventsToFire: StateEnterEvent[]) => Promise<T>) => Promise<T>;
}

type Plan =
  | { kind: "migrate"; fromState: string; toState: string; context: Record<string, unknown> }
  | { kind: "skip"; reason: string };

/** Paging progress shared between the candidate generator and `migrate`. */
interface PagingState {
  examined: number;
  lastExamined: string | null;
  stoppedAtLimit: boolean;
}

function assertStateList(list: readonly string[] | undefined, name: string, nonEmpty: boolean): void {
  if (list === undefined) return;
  if (nonEmpty && Array.isArray(list) && list.length === 0) {
    throw new InvalidArgumentError(`${name} must not be empty`);
  }
  if (!Array.isArray(list) || list.some((state) => typeof state !== "string")) {
    throw new InvalidArgumentError(`${name} must contain only strings`);
  }
}

function passesStateFilter(state: string, input: MigrateInstancesInput): boolean {
  if (input.states !== undefined && !input.states.includes(state)) return false;
  if (input.excludeStates !== undefined && input.excludeStates.includes(state)) return false;
  return true;
}

/**
 * A non-null object whose prototype is null or is some realm's
 * `Object.prototype` (a prototype whose own prototype is null), so plain
 * objects from another realm — e.g. a Jest vm context — pass. Arrays, Dates,
 * Maps and class instances do not.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

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
    assertStateList(input.states, "states", true);
    assertStateList(input.excludeStates, "excludeStates", false);
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== "string" || input.cursor.length === 0) {
        throw new InvalidArgumentError("cursor must be a non-empty string");
      }
      if (input.instanceUuids !== undefined) {
        throw new InvalidArgumentError("cursor cannot be combined with instanceUuids");
      }
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

    const result: MigrateInstancesResult = {
      dryRun: input.dryRun === true,
      migrated: [],
      skipped: [],
      failed: [],
      nextCursor: null,
      warnings: this.targetWarnings(target, input.toVersion),
    };
    const paging: PagingState = { examined: 0, lastExamined: input.cursor ?? null, stoppedAtLimit: false };
    try {
      for await (const uuid of this.candidates(input, paging)) {
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
          result.failed.push({ uuid, error: describeThrown(error) });
        }
      }
    } catch (error: unknown) {
      // Only the candidate generator reaches here: per-candidate errors are caught above.
      result.nextCursor = paging.lastExamined;
      throw new MigrationInterruptedError(result, paging.examined, error);
    }
    if (input.instanceUuids === undefined && paging.stoppedAtLimit) {
      result.nextCursor = paging.lastExamined;
    }
    return result;
  }

  /** Commands and guards the target references that this process hasn't registered. */
  private targetWarnings(target: WorkflowDefinition, toVersion: number): string[] {
    const refs = referencedNames(target);
    const commands = refs.commands.filter((name) => !this.deps.commandRegistry.has(name));
    const guards = refs.guards.filter((name) => !this.deps.guardRegistry?.has(name));
    const missing = [
      ...(commands.length > 0 ? [`commands [${commands.join(", ")}]`] : []),
      ...(guards.length > 0 ? [`guards [${guards.join(", ")}]`] : []),
    ];
    return missing.length > 0 ? [`version ${toVersion} references unregistered ${missing.join(", ")}`] : [];
  }

  /**
   * Explicit UUIDs (de-duplicated, in order) or pages from findInstanceUuids
   * starting after `input.cursor`, capped by `limit`. Records progress in
   * `paging` so `migrate` can report a cursor, including when this throws.
   */
  private async *candidates(input: MigrateInstancesInput, paging: PagingState): AsyncGenerator<string> {
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    if (input.instanceUuids !== undefined) {
      for (const uuid of new Set(input.instanceUuids)) {
        if (paging.examined >= limit) return;
        paging.examined++;
        yield uuid;
      }
      return;
    }
    const store = this.deps.instanceStore;
    let afterUuid = input.cursor;
    while (paging.examined < limit) {
      const requested = Math.min(PAGE_SIZE, limit - paging.examined);
      const page = (
        await store.findInstanceUuids!({
          workflowName: input.workflowName,
          definitionVersion: input.fromVersion,
          limit: requested,
          afterUuid,
          states: input.states,
          excludeStates: input.excludeStates,
        })
      ).slice(0, requested);
      if (page.length === 0) return;
      let previous = afterUuid;
      for (const uuid of page) {
        if (typeof uuid !== "string" || uuid.length === 0) {
          throw new WorkflowError("findInstanceUuids returned a page with an entry that is not a UUID string");
        }
        // `typeof previous === "string"`, not `previous !== undefined`: a page
        // entry that is itself `undefined` must never be mistaken for "no
        // lower bound yet" — that would let a non-conforming page reset the
        // lower bound to nothing and pass forever.
        if (typeof previous === "string" && !(uuid > previous)) {
          throw new WorkflowError(
            `findInstanceUuids returned a page that does not advance past ${afterUuid ?? "the start"}`,
          );
        }
        previous = uuid;
      }
      for (const uuid of page) {
        paging.examined++;
        paging.lastExamined = uuid;
        yield uuid;
      }
      afterUuid = page[page.length - 1];
    }
    paging.stoppedAtLimit = true;
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
    if (!passesStateFilter(fromState, input)) {
      return { kind: "skip", reason: `state ${fromState} is excluded by the state filter` };
    }
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
    const transformed: unknown = input.transformContext(
      structuredClone(instance.context),
      deepFreeze(structuredClone(instance)),
    );
    if (!isPlainObject(transformed)) {
      throw new InvalidArgumentError("transformContext must return a plain object");
    }
    // Checked again after the JSON round trip: a `toJSON` can turn a plain object into a non-object.
    const json = JSON.stringify(transformed) as string | undefined;
    const stored: unknown = json === undefined ? undefined : JSON.parse(json);
    if (!isPlainObject(stored)) {
      throw new InvalidArgumentError("transformContext must return a plain object");
    }
    return stored;
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
