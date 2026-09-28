import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  InMemoryGuardRegistry,
  IncompatibleDefinitionError,
} from "../../src/index.js";
import type { WorkflowDefinition, WorkflowTimeoutRetryOptions } from "../../src/index.js";
import { createInMemoryPersistence, InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";

let now = Date.parse("2026-06-01T00:00:00Z");
const clock = { now: () => new Date(now) };
const minutes = (n: number) => n * 60_000;

// v1 omits `version` (defaults to 1), like a real first version.
const v1: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "review" } } },
    review: { events: { Approve: { targetState: "approved", commands: [{ name: "notify" }] } } },
    approved: {},
  },
};

const v2: WorkflowDefinition = {
  name: "order",
  version: 2,
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "checking" } } },
    checking: { events: { Approve: { targetState: "accepted", commands: [{ name: "notify" }] } } },
    accepted: {},
  },
};

function makeRuntime(
  definition: WorkflowDefinition,
  persistence: ReturnType<typeof createInMemoryPersistence>,
  definitionStore: InMemoryDefinitionStore | undefined,
  timeoutRetry?: WorkflowTimeoutRetryOptions,
  guards: Record<string, boolean> = {},
) {
  const definitionRegistry = new InMemoryDefinitionRegistry();
  definitionRegistry.register(definition);
  const commandRegistry = new InMemoryCommandRegistry();
  commandRegistry.register("notify", { execute: async () => ({ ok: true }) });
  const guardRegistry = new InMemoryGuardRegistry();
  for (const [name, verdict] of Object.entries(guards)) {
    guardRegistry.register(name, { name, evaluate: () => verdict });
  }
  return new WorkflowRuntime({
    definitionRegistry,
    commandRegistry,
    guardRegistry,
    ...persistence,
    definitionStore,
    clock,
    timeoutRetry,
  });
}

function world() {
  const persistence = createInMemoryPersistence();
  const store = new InMemoryDefinitionStore();
  return { persistence, store };
}

afterEach(() => {
  vi.restoreAllMocks();
  now = Date.parse("2026-06-01T00:00:00Z");
});

describe("pinned definition versions", () => {
  it("keeps executing v1 rules for an instance created on v1 after v2 is deployed", async () => {
    const { persistence, store } = world();
    const runtimeV1 = makeRuntime(v1, persistence, store);
    const instance = await runtimeV1.createInstance({ workflowName: "order" });
    await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

    const runtimeV2 = makeRuntime(v2, persistence, store);
    const result = await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Approve" });

    expect(result.toState).toBe("approved");
    const fetched = await runtimeV2.getInstance(instance.uuid);
    expect(fetched!.currentState).toBe("approved");
    expect(fetched!.definitionVersion).toBe(1);
    const history = await runtimeV2.getHistory(instance.uuid);
    expect(history[0].definitionVersion).toBe(1);
  });

  it("starts new instances on the latest version", async () => {
    const { persistence, store } = world();
    await makeRuntime(v1, persistence, store).initialize();
    const runtimeV2 = makeRuntime(v2, persistence, store);
    const instance = await runtimeV2.createInstance({ workflowName: "order" });
    expect(instance.definitionVersion).toBe(2);
    const result = await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
    expect(result.toState).toBe("checking");
  });

  it("lists the pinned version's events in getAvailableEvents", async () => {
    const { persistence, store } = world();
    const runtimeV1 = makeRuntime(v1, persistence, store);
    const instance = await runtimeV1.createInstance({ workflowName: "order" });
    await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

    const runtimeV2 = makeRuntime(v2, persistence, store);
    const events = await runtimeV2.getAvailableEvents({ workflowInstanceUuid: instance.uuid });
    expect(events.map((e) => [e.eventName, e.targetState])).toEqual([["Approve", "approved"]]);
  });

  it("adopts the latest version for a legacy (null-version) instance", async () => {
    const { persistence, store } = world();
    const runtimeV1 = makeRuntime(v1, persistence, store);
    const instance = await runtimeV1.createInstance({ workflowName: "order" });
    const raw = await persistence.instanceStore.findByUuid(instance.uuid);
    raw!.definitionVersion = null;
    raw!.version++;
    await persistence.instanceStore.update(raw!);

    const runtimeV2 = makeRuntime(v2, persistence, store);
    const result = await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
    expect(result.toState).toBe("checking");
    expect((await runtimeV2.getInstance(instance.uuid))!.definitionVersion).toBe(2);
  });

  it("executes the latest definition and warns once when no definition store is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const persistence = createInMemoryPersistence();
    const instance = await makeRuntime(v1, persistence, undefined).createInstance({ workflowName: "order" });

    const runtimeV2 = makeRuntime(v2, persistence, undefined);
    const result = await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

    expect(result.toState).toBe("checking");
    // A second resolution on the same runtime must not warn again.
    await runtimeV2.getAvailableEvents({ workflowInstanceUuid: instance.uuid });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('versionPolicy "latest"', () => {
  const latestV2: WorkflowDefinition = { ...v2, versionPolicy: "latest" };

  it("throws IncompatibleDefinitionError for an instance whose state the latest definition lacks", async () => {
    const { persistence, store } = world();
    const runtimeV1 = makeRuntime(v1, persistence, store);
    const instance = await runtimeV1.createInstance({ workflowName: "order" });
    await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

    const runtimeV2 = makeRuntime(latestV2, persistence, store);
    await expect(
      runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Approve" }),
    ).rejects.toBeInstanceOf(IncompatibleDefinitionError);
    await expect(runtimeV2.getAvailableEvents({ workflowInstanceUuid: instance.uuid })).rejects.toBeInstanceOf(
      IncompatibleDefinitionError,
    );
  });

  it("moves a compatible old-version instance onto the latest definition", async () => {
    const { persistence, store } = world();
    const instance = await makeRuntime(v1, persistence, store).createInstance({ workflowName: "order" });

    const runtimeV2 = makeRuntime(latestV2, persistence, store);
    const result = await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

    expect(result.toState).toBe("checking");
    expect((await runtimeV2.getInstance(instance.uuid))!.definitionVersion).toBe(2);
  });
});

describe("timeout sweep with mixed versions", () => {
  const t1: WorkflowDefinition = {
    name: "reminder",
    initialState: "waiting",
    states: {
      waiting: { events: { Expire: { targetState: "expired-v1", timeout: { afterMinutes: 1 } } } },
      "expired-v1": {},
    },
  };
  const t2: WorkflowDefinition = {
    name: "reminder",
    version: 2,
    initialState: "waiting",
    states: {
      waiting: { events: { Expire: { targetState: "expired-v2", timeout: { afterMinutes: 1 } } } },
      "expired-v2": {},
    },
  };

  it("resolves each instance in a batch against its own version", async () => {
    const { persistence, store } = world();
    const old = await makeRuntime(t1, persistence, store).createInstance({ workflowName: "reminder" });
    const runtimeV2 = makeRuntime(t2, persistence, store);
    const fresh = await runtimeV2.createInstance({ workflowName: "reminder" });
    now += minutes(5);

    const result = await runtimeV2.processExpiredWorkflows();

    expect(result.processed).toBe(2);
    const oldAfter = (await runtimeV2.getInstance(old.uuid))!;
    const freshAfter = (await runtimeV2.getInstance(fresh.uuid))!;
    expect([oldAfter.currentState, oldAfter.definitionVersion]).toEqual(["expired-v1", 1]);
    expect([freshAfter.currentState, freshAfter.definitionVersion]).toEqual(["expired-v2", 2]);
    expect((await runtimeV2.getHistory(old.uuid))[0].definitionVersion).toBe(1);
  });

  it("backs off and then parks an instance whose pinned snapshot is missing", async () => {
    const persistence = createInMemoryPersistence();
    const old = await makeRuntime(t1, persistence, new InMemoryDefinitionStore()).createInstance({
      workflowName: "reminder",
    });
    // A different store that never saw v1: the snapshot is missing.
    const runtimeV2 = makeRuntime(t2, persistence, new InMemoryDefinitionStore(), {
      initialDelayMs: minutes(1),
      maxDelayMs: minutes(1),
      maxAttempts: 2,
    });
    now += minutes(5);

    const first = await runtimeV2.processExpiredWorkflows();
    expect(first.failed).toEqual([
      expect.objectContaining({ uuid: old.uuid, attempts: 1, error: expect.stringMatching(/pinned to version 1/) }),
    ]);

    now += minutes(2);
    const second = await runtimeV2.processExpiredWorkflows();
    expect(second.parked.map((p) => p.uuid)).toEqual([old.uuid]);
  });
});

describe("pinned stamping on the timeout and onEnter paths", () => {
  it("clears a stale deadline using the pinned version and keeps its stamp", async () => {
    const s1: WorkflowDefinition = {
      name: "stale",
      initialState: "idle",
      states: { idle: { events: { Go: { targetState: "done" } } }, done: {} },
    };
    // v2 adds a timeout to "idle"; under v2 the sweep would transition the instance.
    const s2: WorkflowDefinition = {
      name: "stale",
      version: 2,
      initialState: "idle",
      states: {
        idle: {
          events: { Go: { targetState: "done" }, Expire: { targetState: "done", timeout: { afterMinutes: 1 } } },
        },
        done: {},
      },
    };
    const { persistence, store } = world();
    const instance = await makeRuntime(s1, persistence, store).createInstance({ workflowName: "stale" });
    const raw = (await persistence.instanceStore.findByUuid(instance.uuid))!;
    raw.expiresAt = new Date(now - minutes(1));
    raw.version++;
    await persistence.instanceStore.update(raw);

    const runtimeV2 = makeRuntime(s2, persistence, store);
    const result = await runtimeV2.processExpiredWorkflows();

    expect(result.processed).toBe(0);
    const after = (await runtimeV2.getInstance(instance.uuid))!;
    expect(after.currentState).toBe("idle");
    expect(after.expiresAt).toBeNull();
    expect(after.definitionVersion).toBe(1);
  });

  it("applies the pinned version's guard to a timeout and stamps the rejection with it", async () => {
    const g1: WorkflowDefinition = {
      name: "guarded",
      initialState: "waiting",
      states: {
        waiting: {
          events: { Expire: { targetState: "expired", guard: { name: "never" }, timeout: { afterMinutes: 1 } } },
        },
        expired: {},
      },
    };
    // v2 drops the guard; under v2 the timeout would fire.
    const g2: WorkflowDefinition = {
      name: "guarded",
      version: 2,
      initialState: "waiting",
      states: {
        waiting: { events: { Expire: { targetState: "expired", timeout: { afterMinutes: 1 } } } },
        expired: {},
      },
    };
    const { persistence, store } = world();
    const instance = await makeRuntime(g1, persistence, store, undefined, { never: false }).createInstance({
      workflowName: "guarded",
    });
    const runtimeV2 = makeRuntime(g2, persistence, store, undefined, { never: false });
    now += minutes(5);

    const result = await runtimeV2.processExpiredWorkflows();

    expect(result.rejected).toBe(1);
    const after = (await runtimeV2.getInstance(instance.uuid))!;
    expect([after.currentState, after.definitionVersion]).toEqual(["waiting", 1]);
    const [latest] = await runtimeV2.getHistory(instance.uuid);
    expect([latest.outcome, latest.definitionVersion]).toEqual(["guard-rejected", 1]);
  });

  it("follows the pinned version's onEnter chain and stamps every hop with it", async () => {
    const o1: WorkflowDefinition = {
      name: "chain",
      initialState: "new",
      states: {
        new: { events: { Submit: { targetState: "review" } } },
        review: { onEnter: { targetState: "done-v1" } },
        "done-v1": {},
      },
    };
    const o2: WorkflowDefinition = {
      name: "chain",
      version: 2,
      initialState: "new",
      states: {
        new: { events: { Submit: { targetState: "review" } } },
        review: { onEnter: { targetState: "done-v2" } },
        "done-v2": {},
      },
    };
    const { persistence, store } = world();
    const instance = await makeRuntime(o1, persistence, store).createInstance({ workflowName: "chain" });

    const runtimeV2 = makeRuntime(o2, persistence, store);
    const result = await runtimeV2.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

    expect(result.toState).toBe("done-v1");
    expect((await runtimeV2.getInstance(instance.uuid))!.definitionVersion).toBe(1);
    // Rows written in one transaction share a createdAt, so their order is not guaranteed.
    const history = await runtimeV2.getHistory(instance.uuid);
    expect(history.map((h) => [h.toState, h.definitionVersion]).sort()).toEqual([
      ["done-v1", 1],
      ["review", 1],
    ]);
  });

  it('records IncompatibleDefinitionError from the sweep as a retryable failure under "latest"', async () => {
    const r1: WorkflowDefinition = {
      name: "renamed",
      initialState: "waiting",
      states: { waiting: { events: { Expire: { targetState: "gone", timeout: { afterMinutes: 1 } } } }, gone: {} },
    };
    // v2 renames "waiting" to "pending" and opts out of pinning.
    const r2: WorkflowDefinition = {
      name: "renamed",
      version: 2,
      versionPolicy: "latest",
      initialState: "pending",
      states: { pending: { events: { Expire: { targetState: "gone", timeout: { afterMinutes: 1 } } } }, gone: {} },
    };
    const { persistence, store } = world();
    const instance = await makeRuntime(r1, persistence, store).createInstance({ workflowName: "renamed" });
    const runtimeV2 = makeRuntime(r2, persistence, store);
    now += minutes(5);

    const result = await runtimeV2.processExpiredWorkflows();

    expect(result.failed).toEqual([
      expect.objectContaining({
        uuid: instance.uuid,
        attempts: 1,
        error: expect.stringMatching(/state "waiting", which version 2 of workflow "renamed" does not define/),
      }),
    ]);
    expect((await runtimeV2.getInstance(instance.uuid))!.currentState).toBe("waiting");
  });
});
