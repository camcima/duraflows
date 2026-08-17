import { describe, it, expect, vi } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  WorkflowDefinitionError,
  computeDefinitionHash,
} from "../../src/index.js";
import type { WorkflowDefinition } from "../../src/index.js";
import { createInMemoryPersistence, InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";

const clock = { now: () => new Date("2026-06-01T00:00:00Z") };

const orderV2: WorkflowDefinition = {
  name: "order",
  version: 2,
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "submitted" } } },
    submitted: {},
  },
};

function makeRuntime(definition: WorkflowDefinition, definitionStore?: InMemoryDefinitionStore) {
  const definitionRegistry = new InMemoryDefinitionRegistry();
  definitionRegistry.register(definition);
  return new WorkflowRuntime({
    definitionRegistry,
    commandRegistry: new InMemoryCommandRegistry(),
    ...createInMemoryPersistence(),
    definitionStore,
    clock,
  });
}

describe("WorkflowRuntime.initialize", () => {
  it("snapshots each registered definition into the store", async () => {
    const store = new InMemoryDefinitionStore();
    await makeRuntime(orderV2, store).initialize();
    const stored = await store.findByNameAndVersion("order", 2);
    expect(stored).not.toBeNull();
    expect(stored!.contentHash).toBe(computeDefinitionHash(orderV2));
    expect(stored!.definitionJson.initialState).toBe("new");
  });

  it("accepts a re-registration of a known version with unchanged content", async () => {
    const store = new InMemoryDefinitionStore();
    await makeRuntime(orderV2, store).initialize();
    await expect(makeRuntime(structuredClone(orderV2), store).initialize()).resolves.toBeUndefined();
  });

  it("throws WorkflowDefinitionError when content changed without a version bump", async () => {
    const store = new InMemoryDefinitionStore();
    await makeRuntime(orderV2, store).initialize();
    const changed = structuredClone(orderV2);
    changed.states.submitted = { context: { closed: true } };
    await expect(makeRuntime(changed, store).initialize()).rejects.toThrow(WorkflowDefinitionError);
  });

  it("stores a changed definition under its new version after a bump", async () => {
    const store = new InMemoryDefinitionStore();
    await makeRuntime(orderV2, store).initialize();
    const bumped = structuredClone(orderV2);
    bumped.version = 3;
    bumped.states.submitted = { context: { closed: true } };
    await makeRuntime(bumped, store).initialize();
    expect(await store.findByNameAndVersion("order", 2)).not.toBeNull();
    expect(await store.findByNameAndVersion("order", 3)).not.toBeNull();
  });

  it("is idempotent — repeated calls sync once", async () => {
    const store = new InMemoryDefinitionStore();
    const ensureSpy = vi.spyOn(store, "ensure");
    const runtime = makeRuntime(orderV2, store);
    await runtime.initialize();
    await runtime.initialize();
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a definition store", async () => {
    await expect(makeRuntime(orderV2, undefined).initialize()).resolves.toBeUndefined();
  });

  it("initializes lazily on the first mutating operation", async () => {
    const store = new InMemoryDefinitionStore();
    const runtime = makeRuntime(orderV2, store);
    await runtime.createInstance({ workflowName: "order" });
    expect(await store.findByNameAndVersion("order", 2)).not.toBeNull();
  });

  it("propagates the bump-guard error from lazy init and retries on the next call", async () => {
    const store = new InMemoryDefinitionStore();
    await makeRuntime(orderV2, store).initialize();
    const changed = structuredClone(orderV2);
    changed.states.submitted = { context: { closed: true } };
    const runtime = makeRuntime(changed, store);
    await expect(runtime.createInstance({ workflowName: "order" })).rejects.toThrow(WorkflowDefinitionError);
    // A failed sync is not cached: the next operation retries (and fails the same way).
    await expect(runtime.createInstance({ workflowName: "order" })).rejects.toThrow(WorkflowDefinitionError);
  });
});
