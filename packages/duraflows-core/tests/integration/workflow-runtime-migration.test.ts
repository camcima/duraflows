import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  WorkflowDefinitionError,
  WorkflowError,
  InvalidArgumentError,
} from "../../src/index.js";
import type { WorkflowDefinition, WorkflowObserver, StateEnterEvent, WorkflowInstance } from "../../src/index.js";
import { createInMemoryPersistence, InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";

const start = Date.parse("2026-06-01T00:00:00Z");
let now = start;
const clock = { now: () => new Date(now) };
const minutes = (n: number) => n * 60_000;

// v1 omits `version` (defaults to 1). Its Approve runs "legacyNotify"; v2's runs "notify".
const v1: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "review" } } },
    review: {
      events: {
        Approve: { targetState: "approved", commands: [{ name: "legacyNotify" }] },
        Expire: { targetState: "expired", timeout: { afterMinutes: 60 } },
      },
    },
    approved: {},
    expired: {},
  },
};

// v2 renames review → checking, shortens the timeout, and turns "approved" into a pass-through state.
const v2: WorkflowDefinition = {
  name: "order",
  version: 2,
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "checking" } } },
    checking: {
      events: {
        Approve: { targetState: "accepted", commands: [{ name: "notify" }] },
        Expire: { targetState: "expired", timeout: { afterMinutes: 30 } },
      },
    },
    approved: { onEnter: { targetState: "accepted" } },
    accepted: {},
    expired: {},
  },
};

const executed: string[] = [];
const onEnter = vi.fn<(event: StateEnterEvent) => void>();

/**
 * Registers both commands by default so the startup executability check stays
 * quiet; `withLegacy: false` drops "legacyNotify" to make v1 unexecutable.
 */
function makeRuntime(
  definition: WorkflowDefinition,
  persistence: ReturnType<typeof createInMemoryPersistence>,
  definitionStore: InMemoryDefinitionStore | undefined,
  { withLegacy = true }: { withLegacy?: boolean } = {},
) {
  const definitionRegistry = new InMemoryDefinitionRegistry();
  definitionRegistry.register(definition);
  const commandRegistry = new InMemoryCommandRegistry();
  for (const name of withLegacy ? ["notify", "legacyNotify"] : ["notify"]) {
    commandRegistry.register(name, {
      execute: async () => {
        executed.push(name);
        return { ok: true };
      },
    });
  }
  const observer: WorkflowObserver = { name: "spy", onEnter };
  return new WorkflowRuntime({
    definitionRegistry,
    commandRegistry,
    ...persistence,
    definitionStore,
    clock,
    observers: [observer],
  });
}

function world() {
  const persistence = createInMemoryPersistence();
  const store = new InMemoryDefinitionStore();
  const runtimeV1 = makeRuntime(v1, persistence, store);
  const runtimeV2 = makeRuntime(v2, persistence, store);
  return { persistence, store, runtimeV1, runtimeV2 };
}

/** A v1 instance, submitted into "review" at `start`. */
async function inReview(runtimeV1: WorkflowRuntime): Promise<WorkflowInstance> {
  const instance = await runtimeV1.createInstance({ workflowName: "order" });
  await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
  return (await runtimeV1.getInstance(instance.uuid))!;
}

const toV2 = { workflowName: "order", fromVersion: 1, toVersion: 2 };

afterEach(() => {
  vi.restoreAllMocks();
  onEnter.mockReset();
  executed.length = 0;
  now = start;
});

describe("migrateInstances: relabeling", () => {
  it("moves a mapped instance onto the target version without running anything", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const before = await inReview(runtimeV1);
    now += minutes(10);
    onEnter.mockClear();
    executed.length = 0;

    const result = await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    expect(result).toEqual({
      dryRun: false,
      migrated: [{ uuid: before.uuid, fromState: "review", toState: "checking" }],
      skipped: [],
      failed: [],
    });
    const after = (await runtimeV2.getInstance(before.uuid))!;
    expect(after.currentState).toBe("checking");
    expect(after.definitionVersion).toBe(2);
    expect(after.version).toBe(before.version + 1);
    expect(after.lastTransitionAt).toEqual(before.lastTransitionAt);
    expect(after.updatedAt).toEqual(new Date(now));
    expect(executed).toEqual([]);

    const row = (await runtimeV2.getHistory(before.uuid)).find((h) => h.eventName === "$migrated");
    expect(row).toMatchObject({
      fromState: "review",
      toState: "checking",
      outcome: "success",
      commandResultsJson: [],
      definitionVersion: 2,
      triggerMetadata: { source: "migration", fromVersion: 1, toVersion: 2 },
    });
    expect(onEnter).toHaveBeenCalledOnce();
    expect(onEnter.mock.calls[0][0]).toMatchObject({
      instanceUuid: before.uuid,
      fromState: "review",
      toState: "checking",
      triggerEvent: "$migrated",
      triggerMetadata: { source: "migration", fromVersion: 1, toVersion: 2 },
    });

    await runtimeV2.triggerEvent({ workflowInstanceUuid: before.uuid, eventName: "Approve" });
    expect((await runtimeV2.getInstance(before.uuid))!.currentState).toBe("accepted");
    expect(executed).toEqual(["notify"]);
  });

  it("keeps a state that exists under the same name in the target version", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const instance = await runtimeV1.createInstance({ workflowName: "order" });

    const result = await runtimeV2.migrateInstances({ ...toV2 });

    expect(result.migrated).toEqual([{ uuid: instance.uuid, fromState: "new", toState: "new" }]);
    await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
    expect((await runtimeV2.getInstance(instance.uuid))!.currentState).toBe("checking");
  });

  it("recomputes the deadline from lastTransitionAt, so elapsed time is kept", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const before = await inReview(runtimeV1);
    now += minutes(10);

    await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    const after = (await runtimeV2.getInstance(before.uuid))!;
    expect(after.expiresAt).toEqual(new Date(before.lastTransitionAt.getTime() + minutes(30)));
  });

  it("leaves an already-past deadline for the next sweep to fire", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const before = await inReview(runtimeV1);
    now += minutes(45);

    await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });
    const sweep = await runtimeV2.processExpiredWorkflows();

    expect(sweep.processed).toBe(1);
    expect((await runtimeV2.getInstance(before.uuid))!.currentState).toBe("expired");
  });

  it("clears the deadline when the target state has no timeout, including a terminal state", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const before = await inReview(runtimeV1);

    const result = await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "accepted" } });

    expect(result.migrated).toHaveLength(1);
    expect((await runtimeV2.getInstance(before.uuid))!.expiresAt).toBeNull();
  });

  it("clears the timeout retry state of a parked instance", async () => {
    const { persistence, runtimeV1, runtimeV2 } = world();
    const before = await inReview(runtimeV1);
    const raw = (await persistence.instanceStore.findByUuid(before.uuid))!;
    raw.timeoutRetry = { attempts: 10, lastError: "boom", retryAt: null, parkedAt: new Date(now) };
    raw.version++;
    await persistence.instanceStore.update(raw);

    await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    expect((await runtimeV2.getInstance(before.uuid))!.timeoutRetry).toBeNull();
  });

  it("applies transformContext and stores its JSON round trip", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const instance = await runtimeV1.createInstance({ workflowName: "order", context: { tier: "silver" } });
    const seen: Array<Readonly<WorkflowInstance>> = [];

    await runtimeV2.migrateInstances({
      ...toV2,
      transformContext: (context, current) => {
        seen.push(current);
        return { ...context, tier: "gold", migratedAt: new Date(now), dropped: undefined };
      },
    });

    expect(seen[0].uuid).toBe(instance.uuid);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect((await runtimeV2.getInstance(instance.uuid))!.context).toEqual({
      tier: "gold",
      migratedAt: new Date(now).toISOString(),
    });
  });

  it("is harmless to run twice", async () => {
    const { runtimeV1, runtimeV2 } = world();
    await inReview(runtimeV1);
    await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    const second = await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    expect(second).toEqual({ dryRun: false, migrated: [], skipped: [], failed: [] });
  });

  it("migrates down to an older version loaded from its snapshot", async () => {
    const { runtimeV1, runtimeV2 } = world();
    await runtimeV1.initialize();
    const instance = await runtimeV2.createInstance({ workflowName: "order" });

    const result = await runtimeV2.migrateInstances({ workflowName: "order", fromVersion: 2, toVersion: 1 });

    expect(result.migrated).toEqual([{ uuid: instance.uuid, fromState: "new", toState: "new" }]);
    await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
    expect((await runtimeV2.getInstance(instance.uuid))!.currentState).toBe("review");
  });

  it("delivers observers only after an enclosing transaction commits", async () => {
    const { persistence, runtimeV1, runtimeV2 } = world();
    await runtimeV1.createInstance({ workflowName: "order" });
    onEnter.mockClear();

    await persistence.transactionRunner.runInTransaction(async () => {
      await runtimeV2.migrateInstances({ ...toV2 });
      expect(onEnter).not.toHaveBeenCalled();
    });

    expect(onEnter).toHaveBeenCalledOnce();
  });
});

describe("migrateInstances: skips and failures", () => {
  it("reports each skip reason and leaves those instances untouched", async () => {
    const { persistence, store, runtimeV1, runtimeV2 } = world();
    const unmapped = await inReview(runtimeV1);
    const approved = await inReview(runtimeV1);
    await runtimeV1.triggerEvent({ workflowInstanceUuid: approved.uuid, eventName: "Approve" });
    const onV2 = await runtimeV2.createInstance({ workflowName: "order" });
    const unstamped = await runtimeV1.createInstance({ workflowName: "order" });
    const raw = (await persistence.instanceStore.findByUuid(unstamped.uuid))!;
    raw.definitionVersion = null;
    raw.version++;
    await persistence.instanceStore.update(raw);
    const otherRuntime = makeRuntime({ ...v1, name: "other" }, persistence, store);
    const other = await otherRuntime.createInstance({ workflowName: "other" });
    const missing = "00000000-0000-0000-0000-00000000dead";

    const result = await runtimeV2.migrateInstances({
      ...toV2,
      instanceUuids: [unmapped.uuid, approved.uuid, onV2.uuid, unstamped.uuid, other.uuid, missing],
    });

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([
      { uuid: unmapped.uuid, reason: "state review has no mapping and does not exist in version 2" },
      { uuid: approved.uuid, reason: "state approved has an onEnter in version 2" },
      { uuid: onV2.uuid, reason: "on version 2, not 1" },
      { uuid: unstamped.uuid, reason: "unstamped" },
      { uuid: other.uuid, reason: "belongs to workflow other" },
      { uuid: missing, reason: "not found" },
    ]);
    expect((await runtimeV2.getInstance(unmapped.uuid))!.definitionVersion).toBe(1);
  });

  it("skips an instance that moved to another version after it was listed", async () => {
    const { persistence, runtimeV2 } = world();
    const moved = await runtimeV2.createInstance({ workflowName: "order" });
    vi.spyOn(persistence.instanceStore, "findInstanceUuids").mockResolvedValueOnce([moved.uuid]).mockResolvedValue([]);

    const result = await runtimeV2.migrateInstances({ ...toV2 });

    expect(result.skipped).toEqual([{ uuid: moved.uuid, reason: "on version 2, not 1" }]);
  });

  it("does not match a stateMapping key through the prototype", async () => {
    const { persistence, runtimeV1, runtimeV2 } = world();
    const instance = await runtimeV1.createInstance({ workflowName: "order" });
    const raw = (await persistence.instanceStore.findByUuid(instance.uuid))!;
    raw.currentState = "toString";
    raw.version++;
    await persistence.instanceStore.update(raw);

    const result = await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    expect(result.skipped).toEqual([
      { uuid: instance.uuid, reason: "state toString has no mapping and does not exist in version 2" },
    ]);
  });

  it("reports a throwing or invalid transformContext as failed and keeps going", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const bad = await runtimeV1.createInstance({ workflowName: "order", context: { bad: true } });
    const array = await runtimeV1.createInstance({ workflowName: "order", context: { array: true } });
    const good = await runtimeV1.createInstance({ workflowName: "order" });

    const result = await runtimeV2.migrateInstances({
      ...toV2,
      instanceUuids: [bad.uuid, array.uuid, good.uuid],
      transformContext: (context) => {
        if (context.bad) throw new Error("cannot transform");
        if (context.array) return [] as unknown as Record<string, unknown>;
        return context;
      },
    });

    expect(result.failed).toEqual([
      { uuid: bad.uuid, error: "cannot transform" },
      { uuid: array.uuid, error: "transformContext must return a plain object" },
    ]);
    expect(result.migrated.map((m) => m.uuid)).toEqual([good.uuid]);
    expect((await runtimeV2.getInstance(bad.uuid))!.definitionVersion).toBe(1);
  });
});

describe("migrateInstances: dry run", () => {
  it("reports what would happen and writes nothing", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const mapped = await inReview(runtimeV1);
    const failing = await runtimeV1.createInstance({ workflowName: "order", context: { bad: true } });
    const historyBefore = await runtimeV2.getHistory(mapped.uuid);
    onEnter.mockClear();

    const result = await runtimeV2.migrateInstances({
      ...toV2,
      stateMapping: { review: "checking" },
      dryRun: true,
      transformContext: (context) => {
        if (context.bad) throw new Error("cannot transform");
        return context;
      },
    });

    expect(result).toEqual({
      dryRun: true,
      migrated: [{ uuid: mapped.uuid, fromState: "review", toState: "checking" }],
      skipped: [],
      failed: [{ uuid: failing.uuid, error: "cannot transform" }],
    });
    expect((await runtimeV2.getInstance(mapped.uuid))!.definitionVersion).toBe(1);
    expect(await runtimeV2.getHistory(mapped.uuid)).toEqual(historyBefore);
    expect(onEnter).not.toHaveBeenCalled();
  });
});

describe("migrateInstances: paging", () => {
  it("migrates every candidate across several pages", async () => {
    const { runtimeV1, runtimeV2 } = world();
    for (let i = 0; i < 205; i++) await runtimeV1.createInstance({ workflowName: "order" });

    const result = await runtimeV2.migrateInstances({ ...toV2 });

    expect(result.migrated).toHaveLength(205);
    expect(new Set(result.migrated.map((m) => m.uuid)).size).toBe(205);
  });

  it("stops at limit, and a later call continues", async () => {
    const { runtimeV1, runtimeV2 } = world();
    for (let i = 0; i < 120; i++) await runtimeV1.createInstance({ workflowName: "order" });

    const first = await runtimeV2.migrateInstances({ ...toV2, limit: 50 });
    const second = await runtimeV2.migrateInstances({ ...toV2, limit: 100 });

    expect(first.migrated).toHaveLength(50);
    expect(second.migrated).toHaveLength(70);
  });

  it("moves past skipped instances without revisiting them", async () => {
    const { persistence, runtimeV1, runtimeV2 } = world();
    for (let i = 0; i < 110; i++) await inReview(runtimeV1);
    for (let i = 0; i < 5; i++) await runtimeV1.createInstance({ workflowName: "order" });
    const find = vi.spyOn(persistence.instanceStore, "findInstanceUuids");

    const result = await runtimeV2.migrateInstances({ ...toV2 });

    expect(result.skipped).toHaveLength(110);
    expect(result.migrated).toHaveLength(5);
    const seen = [...result.skipped, ...result.migrated].map((r) => r.uuid);
    expect(new Set(seen).size).toBe(115);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("de-duplicates explicit instanceUuids and honours limit on them", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const a = await runtimeV1.createInstance({ workflowName: "order" });
    const b = await runtimeV1.createInstance({ workflowName: "order" });

    const result = await runtimeV2.migrateInstances({ ...toV2, instanceUuids: [a.uuid, a.uuid, b.uuid], limit: 1 });

    expect(result.migrated.map((m) => m.uuid)).toEqual([a.uuid]);
  });
});

describe("migrateInstances: rescue", () => {
  it("migrates an instance whose pinned snapshot is missing", async () => {
    const persistence = createInMemoryPersistence();
    const runtimeV1 = makeRuntime(v1, persistence, new InMemoryDefinitionStore());
    const stuck = await inReview(runtimeV1);
    // A store that never saw v1.
    const runtimeV2 = makeRuntime(v2, persistence, new InMemoryDefinitionStore());

    const result = await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    expect(result.migrated).toHaveLength(1);
    await runtimeV2.triggerEvent({ workflowInstanceUuid: stuck.uuid, eventName: "Approve" });
    expect((await runtimeV2.getInstance(stuck.uuid))!.currentState).toBe("accepted");
  });

  it("works while the startup check fails, and the check passes afterwards", async () => {
    const { persistence, store, runtimeV1 } = world();
    await inReview(runtimeV1);
    const runtimeV2 = makeRuntime(v2, persistence, store, { withLegacy: false });
    await expect(runtimeV2.initialize()).rejects.toThrow("unregistered commands [legacyNotify]");

    const result = await runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "checking" } });

    expect(result.migrated).toHaveLength(1);
    await expect(runtimeV2.initialize()).resolves.toBeUndefined();
  });
});

describe("migrateInstances: upfront validation", () => {
  it("requires a definition store", async () => {
    const runtime = makeRuntime(v2, createInMemoryPersistence(), undefined);
    const promise = runtime.migrateInstances({ ...toV2 });
    await expect(promise).rejects.toBeInstanceOf(WorkflowError);
    await expect(promise).rejects.toThrow("migrateInstances requires a definition store");
  });

  it("rejects an unknown workflow", async () => {
    const { runtimeV2 } = world();
    await expect(runtimeV2.migrateInstances({ ...toV2, workflowName: "nope" })).rejects.toBeInstanceOf(
      WorkflowDefinitionError,
    );
  });

  it.each([
    [{ fromVersion: 0 }, "fromVersion must be a positive integer, got 0"],
    [{ toVersion: 1.5 }, "toVersion must be a positive integer, got 1.5"],
    [{ toVersion: 1 }, "fromVersion and toVersion must differ"],
    [{ limit: 0 }, "limit must be a positive integer, got 0"],
  ])("rejects invalid arguments %j", async (patch, message) => {
    const { runtimeV2 } = world();
    const promise = runtimeV2.migrateInstances({ ...toV2, ...patch });
    await expect(promise).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(promise).rejects.toThrow(message);
  });

  it("rejects a target version that is not stored", async () => {
    const { runtimeV2 } = world();
    await expect(runtimeV2.migrateInstances({ ...toV2, toVersion: 3 })).rejects.toThrow(
      'Workflow "order": version 3 is not in the definition store',
    );
  });

  it("rejects a mapping to an unknown state or to a state with an onEnter, writing nothing", async () => {
    const { runtimeV1, runtimeV2 } = world();
    const instance = await inReview(runtimeV1);

    await expect(runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "nowhere" } })).rejects.toThrow(
      'stateMapping maps "review" to "nowhere", which is not a state of version 2',
    );
    await expect(runtimeV2.migrateInstances({ ...toV2, stateMapping: { review: "approved" } })).rejects.toThrow(
      'stateMapping maps "review" to "approved", which has an onEnter in version 2',
    );
    expect((await runtimeV2.getInstance(instance.uuid))!.definitionVersion).toBe(1);
  });

  it("requires instanceUuids when the store cannot list candidates", async () => {
    const { persistence, runtimeV2 } = world();
    Object.defineProperty(persistence.instanceStore, "findInstanceUuids", { value: undefined });
    const promise = runtimeV2.migrateInstances({ ...toV2 });
    await expect(promise).rejects.toBeInstanceOf(WorkflowError);
    await expect(promise).rejects.toThrow(
      "migrateInstances without instanceUuids requires an instance store that implements findInstanceUuids",
    );
  });
});
