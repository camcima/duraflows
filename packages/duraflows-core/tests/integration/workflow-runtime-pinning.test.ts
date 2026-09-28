import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
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
) {
  const definitionRegistry = new InMemoryDefinitionRegistry();
  definitionRegistry.register(definition);
  const commandRegistry = new InMemoryCommandRegistry();
  commandRegistry.register("notify", { execute: async () => ({ ok: true }) });
  return new WorkflowRuntime({
    definitionRegistry,
    commandRegistry,
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
    expect((await runtimeV2.getInstance(old.uuid))!.currentState).toBe("expired-v1");
    expect((await runtimeV2.getInstance(fresh.uuid))!.currentState).toBe("expired-v2");
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
