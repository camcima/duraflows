import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WorkflowRuntime,
  InMemoryDefinitionRegistry,
  InMemoryCommandRegistry,
  InMemoryGuardRegistry,
  WorkflowDefinitionError,
  WorkflowError,
  InvalidArgumentError,
  computeDefinitionHash,
} from "../../src/index.js";
import type { WorkflowDefinition } from "../../src/index.js";
import { createInMemoryPersistence, InMemoryDefinitionStore } from "../helpers/in-memory-persistence.js";

const clock = { now: () => new Date("2026-06-01T00:00:00Z") };

const v1: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: {
      events: { Pay: { targetState: "paid", guard: { name: "isVip" }, commands: [{ name: "legacyCharge" }] } },
    },
    paid: {},
  },
};

const v2: WorkflowDefinition = {
  name: "order",
  version: 2,
  initialState: "new",
  states: { new: { events: { Pay: { targetState: "paid", commands: [{ name: "charge" }] } } }, paid: {} },
};

interface RuntimeSetup {
  commands: string[];
  guards?: string[];
  onUnresolvable?: "fail" | "warn";
  withStore?: boolean;
}

function makeRuntime(
  definition: WorkflowDefinition,
  persistence: ReturnType<typeof createInMemoryPersistence>,
  store: InMemoryDefinitionStore,
  setup: RuntimeSetup,
) {
  const definitionRegistry = new InMemoryDefinitionRegistry();
  definitionRegistry.register(definition);
  const commandRegistry = new InMemoryCommandRegistry();
  for (const name of setup.commands) commandRegistry.register(name, { execute: async () => ({ ok: true }) });
  let guardRegistry: InMemoryGuardRegistry | undefined;
  if (setup.guards) {
    guardRegistry = new InMemoryGuardRegistry();
    for (const name of setup.guards) guardRegistry.register(name, { name, evaluate: () => true });
  }
  return new WorkflowRuntime({
    definitionRegistry,
    commandRegistry,
    guardRegistry,
    ...persistence,
    definitionStore: setup.withStore === false ? undefined : store,
    clock,
    onUnresolvable: setup.onUnresolvable,
  });
}

/** One active v1 instance (in "new") exists in the returned world. */
async function worldWithActiveV1() {
  const persistence = createInMemoryPersistence();
  const store = new InMemoryDefinitionStore();
  const runtimeV1 = makeRuntime(v1, persistence, store, { commands: ["legacyCharge"], guards: ["isVip"] });
  const instance = await runtimeV1.createInstance({ workflowName: "order" });
  return { persistence, store, runtimeV1, instance };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startup executability check", () => {
  it("fails initialize() when an active older version references unregistered commands and guards", async () => {
    const { persistence, store } = await worldWithActiveV1();
    const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge"], guards: [] });
    const promise = runtimeV2.initialize();
    await expect(promise).rejects.toBeInstanceOf(WorkflowDefinitionError);
    await expect(promise).rejects.toThrow(
      new WorkflowDefinitionError(
        "order",
        "version 1 (1 active instance) references unregistered commands [legacyCharge], guards [isVip]. " +
          'Register the missing commands and guards, set versionPolicy: "latest" on the workflow, ' +
          'or set onUnresolvable: "warn".',
      ).message,
    );
    await expect(promise).rejects.toThrow(/^Workflow "order": version 1 \(/);
  });

  it('only warns with onUnresolvable: "warn"', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { persistence, store } = await worldWithActiveV1();
    const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge"], guards: [], onUnresolvable: "warn" });
    await expect(runtimeV2.initialize()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unregistered commands \[legacyCharge\]/));
  });

  it("ignores a version whose instances all rest in terminal states", async () => {
    const { persistence, store, runtimeV1, instance } = await worldWithActiveV1();
    await runtimeV1.triggerEvent({ workflowInstanceUuid: instance.uuid, eventName: "Pay" });
    const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge"], guards: [] });
    await expect(runtimeV2.initialize()).resolves.toBeUndefined();
  });

  it("counts guard references as missing when no guard registry is configured", async () => {
    const { persistence, store } = await worldWithActiveV1();
    const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge", "legacyCharge"] });
    const promise = runtimeV2.initialize();
    await expect(promise).rejects.toThrow("references unregistered guards [isVip]");
    let error: unknown;
    try {
      await promise;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("commands [");
  });

  it('skips workflows whose registered definition uses versionPolicy "latest"', async () => {
    const { persistence, store } = await worldWithActiveV1();
    const runtimeV2 = makeRuntime({ ...v2, versionPolicy: "latest" }, persistence, store, {
      commands: ["charge"],
      guards: [],
    });
    await expect(runtimeV2.initialize()).resolves.toBeUndefined();
  });

  describe("a structurally invalid stored version with an active instance", () => {
    // Accepted by 6.x validation, rejected since 7.0: "$"-prefixed event names are reserved.
    const invalidV1: WorkflowDefinition = {
      name: "order",
      initialState: "new",
      states: {
        new: {
          events: {
            $Retry: { targetState: "new" },
            Pay: { targetState: "paid", commands: [{ name: "legacyCharge" }] },
          },
        },
        paid: {},
      },
    };

    async function worldWithInvalidV1() {
      const persistence = createInMemoryPersistence();
      const store = new InMemoryDefinitionStore();
      await store.ensure({
        workflowName: "order",
        version: 1,
        contentHash: computeDefinitionHash(invalidV1),
        definitionJson: invalidV1,
      });
      const now = clock.now();
      await persistence.instanceStore.create({
        uuid: "00000000-0000-4000-8000-000000000001",
        workflowName: "order",
        currentState: "new",
        version: 1,
        definitionVersion: 1,
        expiresAt: null,
        timeoutRetry: null,
        lastTransitionAt: now,
        context: {},
        metadata: {},
        createdAt: now,
        updatedAt: now,
      });
      return { persistence, store };
    }

    it("fails initialize()", async () => {
      const { persistence, store } = await worldWithInvalidV1();
      const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge", "legacyCharge"], guards: [] });
      const promise = runtimeV2.initialize();
      await expect(promise).rejects.toBeInstanceOf(WorkflowDefinitionError);
      await expect(promise).rejects.toThrow(
        'version 1 (1 active instance) is invalid: Event names starting with "$" are reserved',
      );
    });

    it("reports missing references and structural errors together", async () => {
      const { persistence, store } = await worldWithInvalidV1();
      const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge"], guards: [] });
      await expect(runtimeV2.initialize()).rejects.toThrow(
        "version 1 (1 active instance) references unregistered commands [legacyCharge] and is invalid: " +
          'Event names starting with "$" are reserved',
      );
    });

    it('only warns with onUnresolvable: "warn"', async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { persistence, store } = await worldWithInvalidV1();
      const runtimeV2 = makeRuntime(v2, persistence, store, {
        commands: ["charge", "legacyCharge"],
        guards: [],
        onUnresolvable: "warn",
      });
      await expect(runtimeV2.initialize()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/version 1 \(1 active instance\) is invalid/));
    });
  });

  it("names only the commands when every guard is registered", async () => {
    const { persistence, store } = await worldWithActiveV1();
    const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge"], guards: ["isVip"] });
    const error = await runtimeV2.initialize().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkflowDefinitionError);
    expect((error as Error).message).toContain("references unregistered commands [legacyCharge]. ");
    expect((error as Error).message).not.toContain("guards [");
  });

  it("re-runs the check on the next initialize() after a failure", async () => {
    const { persistence, store } = await worldWithActiveV1();
    const definitionRegistry = new InMemoryDefinitionRegistry();
    definitionRegistry.register(v2);
    const commandRegistry = new InMemoryCommandRegistry();
    commandRegistry.register("charge", { execute: async () => ({ ok: true }) });
    const guardRegistry = new InMemoryGuardRegistry();
    guardRegistry.register("isVip", { name: "isVip", evaluate: () => true });
    const runtimeV2 = new WorkflowRuntime({
      definitionRegistry,
      commandRegistry,
      guardRegistry,
      ...persistence,
      definitionStore: store,
      clock,
    });

    await expect(runtimeV2.initialize()).rejects.toThrow("unregistered commands [legacyCharge]");
    commandRegistry.register("legacyCharge", { execute: async () => ({ ok: true }) });
    await expect(runtimeV2.initialize()).resolves.toBeUndefined();
  });

  it("does not run without a definition store", async () => {
    const persistence = createInMemoryPersistence();
    const runtime = makeRuntime(v2, persistence, new InMemoryDefinitionStore(), { commands: [], withStore: false });
    await expect(runtime.initialize()).resolves.toBeUndefined();
  });

  it("rejects an unknown onUnresolvable value", () => {
    expect(() =>
      makeRuntime(v2, createInMemoryPersistence(), new InMemoryDefinitionStore(), {
        commands: [],
        onUnresolvable: "ignore" as "warn",
      }),
    ).toThrow(InvalidArgumentError);
  });
});

describe("listDefinitionVersions", () => {
  it("reports each stored version in order with its active-instance count", async () => {
    const { persistence, store } = await worldWithActiveV1();
    const runtimeV2 = makeRuntime(v2, persistence, store, {
      commands: ["charge", "legacyCharge"],
      guards: ["isVip"],
    });
    const fresh = await runtimeV2.createInstance({ workflowName: "order" });
    await runtimeV2.triggerEvent({ workflowInstanceUuid: fresh.uuid, eventName: "Pay" });
    await runtimeV2.createInstance({ workflowName: "order" });

    const versions = await runtimeV2.listDefinitionVersions("order");

    expect(versions).toEqual([
      { version: 1, contentHash: computeDefinitionHash(v1), registeredAt: expect.any(Date), activeInstances: 1 },
      { version: 2, contentHash: computeDefinitionHash(v2), registeredAt: expect.any(Date), activeInstances: 1 },
    ]);
  });

  it("works while initialize() is failing the startup check", async () => {
    const { persistence, store } = await worldWithActiveV1();
    const runtimeV2 = makeRuntime(v2, persistence, store, { commands: ["charge"], guards: [] });
    await expect(runtimeV2.initialize()).rejects.toThrow(WorkflowDefinitionError);

    const versions = await runtimeV2.listDefinitionVersions("order");

    // The sync ran before the check failed, so v2 is stored too.
    expect(versions.map((v) => [v.version, v.activeInstances])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("throws without a definition store", async () => {
    const runtime = makeRuntime(v2, createInMemoryPersistence(), new InMemoryDefinitionStore(), {
      commands: [],
      withStore: false,
    });
    const promise = runtime.listDefinitionVersions("order");
    await expect(promise).rejects.toBeInstanceOf(WorkflowError);
    await expect(promise).rejects.toThrow("listDefinitionVersions requires a definition store");
  });
});
