import { describe, it, expect, vi, afterEach } from "vitest";
import { DefinitionResolver } from "../../src/runtime/definition-resolver.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { IncompatibleDefinitionError, WorkflowDefinitionError, WorkflowError } from "../../src/errors/index.js";
import { computeDefinitionHash } from "../../src/util/definition-hash.js";
import { InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowInstance } from "../../src/types/runtime.js";

// v1 deliberately omits `version` (defaults to 1), as real first versions do.
const v1: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "review" } } },
    review: { events: { Approve: { targetState: "done" } } },
    done: {},
  },
};

const v2: WorkflowDefinition = {
  name: "order",
  version: 2,
  initialState: "new",
  states: {
    new: { events: { Submit: { targetState: "checking" } } },
    checking: { events: { Approve: { targetState: "done" } } },
    done: {},
  },
};

function instanceOf(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    uuid: "00000000-0000-0000-0000-000000000001",
    workflowName: "order",
    currentState: "review",
    version: 1,
    definitionVersion: 1,
    expiresAt: null,
    timeoutRetry: null,
    lastTransitionAt: new Date(0),
    context: {},
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

async function setup(
  latest: WorkflowDefinition,
  options: { withStore?: boolean; snapshots?: WorkflowDefinition[] } = {},
) {
  const definitionRegistry = new InMemoryDefinitionRegistry();
  definitionRegistry.register(latest);
  const definitionStore = options.withStore === false ? undefined : new InMemoryDefinitionStore();
  for (const snapshot of options.snapshots ?? []) {
    await definitionStore!.ensure({
      workflowName: snapshot.name,
      version: snapshot.version ?? 1,
      contentHash: computeDefinitionHash(snapshot),
      definitionJson: snapshot,
    });
  }
  const resolver = new DefinitionResolver({ definitionRegistry, compiler: new WorkflowCompiler(), definitionStore });
  return { resolver, definitionRegistry, definitionStore };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DefinitionResolver.forNewInstance", () => {
  it("returns the registered definition and a compiled process", async () => {
    const { resolver, definitionRegistry } = await setup(v2);
    const resolved = resolver.forNewInstance("order");
    expect(resolved.definition).toBe(definitionRegistry.get("order"));
    expect(resolved.compiled.process).toBeDefined();
  });
});

describe("DefinitionResolver.forInstance", () => {
  it("resolves the latest definition without a store, warning once while a pinned definition is registered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolver } = await setup(v2, { withStore: false });

    const resolved = await resolver.forInstance(instanceOf({ currentState: "new" }));
    await resolver.forInstance(instanceOf({ currentState: "new" }));

    expect(resolved.definition.version).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/pinning is inactive because no definition store is configured/);
  });

  it("does not warn without a store when every definition uses the latest policy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolver } = await setup({ ...v2, versionPolicy: "latest" }, { withStore: false });
    await resolver.forInstance(instanceOf({ currentState: "new" }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves a legacy (null-version) instance to the latest definition without reading the store", async () => {
    const { resolver, definitionStore } = await setup(v2, { snapshots: [v1] });
    const find = vi.spyOn(definitionStore!, "findByNameAndVersion");
    const resolved = await resolver.forInstance(instanceOf({ definitionVersion: null, currentState: "new" }));
    expect(resolved.definition.version).toBe(2);
    expect(find).not.toHaveBeenCalled();
  });

  it("resolves an instance pinned to the in-code version without reading the store", async () => {
    const { resolver, definitionRegistry, definitionStore } = await setup(v2);
    const find = vi.spyOn(definitionStore!, "findByNameAndVersion");
    const resolved = await resolver.forInstance(instanceOf({ definitionVersion: 2, currentState: "checking" }));
    expect(resolved.definition).toBe(definitionRegistry.get("order"));
    expect(find).not.toHaveBeenCalled();
  });

  it("loads an older pinned version once and reuses it while the stored content is unchanged", async () => {
    const { resolver, definitionStore } = await setup(v2, { snapshots: [v1] });
    const find = vi.spyOn(definitionStore!, "findByNameAndVersion");

    const first = await resolver.forInstance(instanceOf());
    const second = await resolver.forInstance(instanceOf({ uuid: "00000000-0000-0000-0000-000000000002" }));

    expect(Object.hasOwn(first.definition.states, "review")).toBe(true);
    expect(first.definition.version).toBeUndefined();
    expect(Object.isFrozen(first.definition)).toBe(true);
    expect(first.compiled.process).toBeDefined();
    expect(second).toBe(first);
    // Each resolution re-reads the row to confirm the cached copy is still what is stored.
    expect(find).toHaveBeenCalledTimes(2);
    expect(find).toHaveBeenCalledWith("order", 1);
  });

  it("reloads a pinned version whose stored content changed since it was cached", async () => {
    const { resolver, definitionStore } = await setup(v2, { snapshots: [v1] });
    const first = await resolver.forInstance(instanceOf());
    // E.g. the cached copy came from a row that rolled back, and different v1 content was committed.
    const replacement: WorkflowDefinition = {
      ...v1,
      states: {
        ...v1.states,
        review: { events: { Approve: { targetState: "done" }, Reject: { targetState: "done" } } },
      },
    };
    vi.spyOn(definitionStore!, "findByNameAndVersion").mockResolvedValueOnce({
      workflowName: "order",
      version: 1,
      contentHash: computeDefinitionHash(replacement),
      definitionJson: replacement,
      registeredAt: new Date(),
    });

    const second = await resolver.forInstance(instanceOf());

    expect(second).not.toBe(first);
    expect(Object.hasOwn(second.definition.states.review.events!, "Reject")).toBe(true);
  });

  it("throws WorkflowDefinitionError when the pinned version's snapshot is missing", async () => {
    const { resolver } = await setup(v2);
    const promise = resolver.forInstance(instanceOf());
    await expect(promise).rejects.toThrow(WorkflowDefinitionError);
    await expect(promise).rejects.toThrow(
      'Workflow "order": instance 00000000-0000-0000-0000-000000000001 is pinned to version 1, ' +
        "which is not in the definition store",
    );
  });

  it("retries the store after a transient failure instead of caching it", async () => {
    const { resolver, definitionStore } = await setup(v2, { snapshots: [v1] });
    vi.spyOn(definitionStore!, "findByNameAndVersion").mockRejectedValueOnce(new Error("db down"));

    await expect(resolver.forInstance(instanceOf())).rejects.toThrow("db down");
    const resolved = await resolver.forInstance(instanceOf());
    expect(Object.hasOwn(resolved.definition.states, "review")).toBe(true);
  });

  it("throws WorkflowDefinitionError when the stored snapshot is structurally invalid", async () => {
    const { resolver, definitionStore } = await setup(v2);
    const broken: WorkflowDefinition = { ...v1, initialState: "missing" };
    await definitionStore!.ensure({
      workflowName: "order",
      version: 1,
      contentHash: computeDefinitionHash(broken),
      definitionJson: broken,
    });
    await expect(resolver.forInstance(instanceOf())).rejects.toThrow(/Workflow "order": stored version 1 is invalid: /);
  });

  describe('with versionPolicy "latest"', () => {
    const latestV2: WorkflowDefinition = { ...v2, versionPolicy: "latest" };

    it("resolves an old-version instance whose state still exists to the latest definition", async () => {
      const { resolver, definitionStore } = await setup(latestV2, { snapshots: [v1] });
      const find = vi.spyOn(definitionStore!, "findByNameAndVersion");
      const resolved = await resolver.forInstance(instanceOf({ currentState: "new" }));
      expect(resolved.definition.version).toBe(2);
      expect(find).not.toHaveBeenCalled();
    });

    it("throws IncompatibleDefinitionError when the latest definition lacks the current state", async () => {
      const { resolver } = await setup(latestV2, { snapshots: [v1] });
      const promise = resolver.forInstance(instanceOf({ currentState: "review" }));
      await expect(promise).rejects.toBeInstanceOf(IncompatibleDefinitionError);
      await expect(promise).rejects.toMatchObject({ workflowName: "order", currentState: "review", version: 2 });
    });

    it("does not accept an inherited Object.prototype key as a state", async () => {
      const { resolver } = await setup(latestV2);
      await expect(resolver.forInstance(instanceOf({ currentState: "toString" }))).rejects.toBeInstanceOf(
        IncompatibleDefinitionError,
      );
    });
  });
});

describe("DefinitionResolver.forVersion", () => {
  it("returns the registered definition for the in-code version without reading the store", async () => {
    const { resolver, definitionRegistry, definitionStore } = await setup(v2);
    const find = vi.spyOn(definitionStore!, "findByNameAndVersion");
    const resolved = await resolver.forVersion("order", 2);
    expect(resolved.definition).toBe(definitionRegistry.get("order"));
    expect(find).not.toHaveBeenCalled();
  });

  it("loads another version from its snapshot and shares the cache with forInstance", async () => {
    const { resolver, definitionStore } = await setup(v2, { snapshots: [v1] });
    const find = vi.spyOn(definitionStore!, "findByNameAndVersion");
    const byVersion = await resolver.forVersion("order", 1);
    const byInstance = await resolver.forInstance(instanceOf());
    expect(Object.hasOwn(byVersion.definition.states, "review")).toBe(true);
    expect(byInstance).toBe(byVersion);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("throws WorkflowDefinitionError when the version is not in the store", async () => {
    const { resolver } = await setup(v2);
    await expect(resolver.forVersion("order", 7)).rejects.toThrow(
      'Workflow "order": version 7 is not in the definition store',
    );
  });

  it("throws WorkflowError for a version other than the in-code one without a store", async () => {
    const { resolver } = await setup(v2, { withStore: false });
    await expect(resolver.forVersion("order", 1)).rejects.toBeInstanceOf(WorkflowError);
  });
});
