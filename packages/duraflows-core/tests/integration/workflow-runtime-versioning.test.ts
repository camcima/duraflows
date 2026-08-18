import { describe, it, expect } from "vitest";
import { WorkflowRuntime, InMemoryDefinitionRegistry, InMemoryCommandRegistry } from "../../src/index.js";
import type { WorkflowDefinition } from "../../src/index.js";
import { createInMemoryPersistence } from "../helpers/in-memory-persistence.js";

const clock = { now: () => new Date("2026-06-01T00:00:00Z") };

function makeRuntime(definition: WorkflowDefinition, persistence = createInMemoryPersistence()) {
  const definitionRegistry = new InMemoryDefinitionRegistry();
  definitionRegistry.register(definition);
  const runtime = new WorkflowRuntime({
    definitionRegistry,
    commandRegistry: new InMemoryCommandRegistry(),
    ...persistence,
    clock,
  });
  return { runtime, persistence };
}

const orderV2: WorkflowDefinition = {
  name: "order",
  version: 2,
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "submitted" } } },
    submitted: {},
  },
};

describe("definition version stamping", () => {
  it("stamps a new instance with the definition's version", async () => {
    const { runtime } = makeRuntime(orderV2);
    const instance = await runtime.createInstance({ workflowName: "order" });
    expect(instance.definitionVersion).toBe(2);
    const fetched = await runtime.getInstance(instance.uuid);
    expect(fetched!.definitionVersion).toBe(2);
  });

  it("defaults to version 1 when the definition has no version field", async () => {
    const { runtime } = makeRuntime({ ...orderV2, version: undefined });
    const instance = await runtime.createInstance({ workflowName: "order" });
    expect(instance.definitionVersion).toBe(1);
  });

  it("stamps history records with the governing version", async () => {
    const { runtime } = makeRuntime(orderV2);
    const instance = await runtime.createInstance({ workflowName: "order" });
    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
    const history = await runtime.getHistory(instance.uuid);
    expect(history[0].definitionVersion).toBe(2);
  });

  it("re-stamps a legacy (null-version) instance on its next successful transition", async () => {
    const persistence = createInMemoryPersistence();
    const { runtime } = makeRuntime(orderV2, persistence);
    const instance = await runtime.createInstance({ workflowName: "order" });

    // Simulate a pre-versioning row: null the stamp directly in the store.
    const raw = await persistence.instanceStore.findByUuid(instance.uuid);
    raw!.definitionVersion = null;
    raw!.version++; // update() expects a pre-incremented optimistic-lock version
    await persistence.instanceStore.update(raw!);

    await runtime.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });
    const fetched = await runtime.getInstance(instance.uuid);
    expect(fetched!.definitionVersion).toBe(2);
  });

  it("re-stamps to the currently governing version when a newer runtime processes an old instance", async () => {
    const persistence = createInMemoryPersistence();
    const { runtime: runtimeV2 } = makeRuntime(orderV2, persistence);
    const instance = await runtimeV2.createInstance({ workflowName: "order" });

    const { runtime: runtimeV3 } = makeRuntime({ ...orderV2, version: 3 }, persistence);
    await runtimeV3.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Submit" });

    const fetched = await runtimeV3.getInstance(instance.uuid);
    expect(fetched!.definitionVersion).toBe(3);
    const history = await runtimeV3.getHistory(instance.uuid);
    expect(history[0].definitionVersion).toBe(3);
  });
});
