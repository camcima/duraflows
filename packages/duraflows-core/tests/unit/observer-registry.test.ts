import { describe, it, expect, vi } from "vitest";
import { ObserverRegistry } from "../../src/runtime/observer-registry.js";
import type { WorkflowObserver, StateEnterEvent } from "../../src/types/observer.js";

function makeEvent(overrides: Partial<StateEnterEvent> = {}): StateEnterEvent {
  return {
    workflowName: "wf",
    instanceUuid: "inst-1",
    state: "stateA",
    fromState: null,
    toState: "stateA",
    transitionUuid: "uuid-1",
    triggerEvent: null,
    context: {},
    metadata: {},
    triggerMetadata: {},
    occurredAt: new Date("2026-04-23T00:00:00Z"),
    ...overrides,
  };
}

describe("ObserverRegistry", () => {
  it("starts empty and accepts observers", () => {
    const registry = new ObserverRegistry();
    expect(registry.list()).toEqual([]);

    const obs: WorkflowObserver = { name: "test-obs" };
    registry.add(obs);
    expect(registry.list()).toEqual([obs]);
  });

  it("seeds initial observers from the constructor", () => {
    const obs1: WorkflowObserver = { name: "obs1" };
    const obs2: WorkflowObserver = { name: "obs2" };
    const registry = new ObserverRegistry([obs1, obs2]);
    expect(registry.list()).toEqual([obs1, obs2]);
  });

  it("fires onEnter on every registered observer with onEnter defined", async () => {
    const obs1Spy = vi.fn();
    const obs2Spy = vi.fn();
    const registry = new ObserverRegistry([
      { name: "o1", onEnter: obs1Spy },
      { name: "o2" },
      { name: "o3", onEnter: obs2Spy },
    ]);

    const event = makeEvent();
    await registry.fireOnEnter(event);

    expect(obs1Spy).toHaveBeenCalledWith(event);
    expect(obs2Spy).toHaveBeenCalledWith(event);
  });

  it("calls observers sequentially in registration order", async () => {
    const callOrder: string[] = [];
    const registry = new ObserverRegistry([
      {
        name: "first",
        onEnter: async () => {
          await new Promise((r) => setTimeout(r, 10));
          callOrder.push("first");
        },
      },
      {
        name: "second",
        onEnter: () => {
          callOrder.push("second");
        },
      },
    ]);

    await registry.fireOnEnter(makeEvent());
    expect(callOrder).toEqual(["first", "second"]);
  });

  it("logs but does not propagate observer errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const followingSpy = vi.fn();

    const registry = new ObserverRegistry([
      {
        name: "throws",
        onEnter: () => {
          throw new Error("observer broke");
        },
      },
      {
        name: "rejects",
        onEnter: async () => {
          throw new Error("async-broke");
        },
      },
      {
        name: "ok-after",
        onEnter: followingSpy,
      },
    ]);

    await expect(registry.fireOnEnter(makeEvent())).resolves.toBeUndefined();

    expect(followingSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
