import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkflowService } from "../../src/services/workflow.service.js";
import { WorkflowHandle, type WorkflowDefinition } from "@duraflows/core";

function createMocks() {
  const runtime = {
    createInstance: vi.fn().mockResolvedValue({ uuid: "new-uuid", currentState: "start" }),
    triggerEvent: vi.fn().mockResolvedValue({ outcome: "success", toState: "done" }),
    getAvailableEvents: vi.fn().mockResolvedValue([{ eventName: "Go" }]),
    getInstance: vi.fn().mockResolvedValue({ uuid: "inst-uuid", currentState: "pending" }),
    getHistory: vi.fn().mockResolvedValue([{ eventName: "Created" }]),
  };

  const service = new WorkflowService(runtime as any);

  return { service, runtime };
}

describe("WorkflowService", () => {
  it("createInstance() delegates to runtime", async () => {
    const { service, runtime } = createMocks();
    const input = { workflowName: "order" };

    const result = await service.createInstance(input);

    expect(runtime.createInstance).toHaveBeenCalledWith(input);
    expect(result.uuid).toBe("new-uuid");
  });

  it("triggerEvent() delegates to runtime", async () => {
    const { service, runtime } = createMocks();
    const input = {
      workflowInstanceUuid: "uuid",
      eventName: "Pay",
    };

    const result = await service.triggerEvent(input);

    expect(runtime.triggerEvent).toHaveBeenCalledWith(input);
    expect(result.outcome).toBe("success");
  });

  it("getAvailableEvents() delegates to runtime", async () => {
    const { service, runtime } = createMocks();
    const input = { workflowInstanceUuid: "uuid" };

    const result = await service.getAvailableEvents(input);

    expect(runtime.getAvailableEvents).toHaveBeenCalledWith(input);
    expect(result).toHaveLength(1);
  });

  it("getInstance() delegates to runtime", async () => {
    const { service, runtime } = createMocks();

    const result = await service.getInstance("inst-uuid");

    expect(runtime.getInstance).toHaveBeenCalledWith("inst-uuid");
    expect(result!.uuid).toBe("inst-uuid");
  });

  it("getHistory() delegates to runtime with pagination", async () => {
    const { service, runtime } = createMocks();

    const result = await service.getHistory("inst-uuid", { limit: 10, offset: 5 });

    expect(runtime.getHistory).toHaveBeenCalledWith("inst-uuid", {
      limit: 10,
      offset: 5,
    });
    expect(result).toHaveLength(1);
  });

  it("getHistory() delegates to runtime without pagination options", async () => {
    const { service, runtime } = createMocks();

    await service.getHistory("inst-uuid");

    expect(runtime.getHistory).toHaveBeenCalledWith("inst-uuid", undefined);
  });

  it("getHandle() returns a WorkflowHandle with the correct uuid", () => {
    const { service } = createMocks();

    const handle = service.getHandle("my-uuid");

    expect(handle).toBeInstanceOf(WorkflowHandle);
    expect(handle.uuid).toBe("my-uuid");
  });

  describe("createInstanceFor()", () => {
    const orderDefinition: WorkflowDefinition<"new" | "paid"> = {
      name: "order",
      initialState: "new",
      states: {
        new: { events: { Pay: { targetState: "paid" } } },
        paid: {},
      },
    };

    it("delegates to runtime.createInstance with workflowName from the definition", async () => {
      const { service, runtime } = createMocks();

      await service.createInstanceFor(orderDefinition, { metadata: { orderId: "o1" } });

      expect(runtime.createInstance).toHaveBeenCalledWith({
        workflowName: "order",
        metadata: { orderId: "o1" },
      });
    });

    it("defaults to an empty input when none is supplied", async () => {
      const { service, runtime } = createMocks();

      await service.createInstanceFor(orderDefinition);

      expect(runtime.createInstance).toHaveBeenCalledWith({ workflowName: "order" });
    });

    it("returns the runtime instance unchanged at runtime (narrowing is type-only)", async () => {
      const { service, runtime } = createMocks();
      const runtimeInstance = { uuid: "u", currentState: "new" };
      runtime.createInstance.mockResolvedValueOnce(runtimeInstance);

      const result = await service.createInstanceFor(orderDefinition);

      expect(result).toBe(runtimeInstance);
    });

    it("ignores any workflowName the caller would try to slip in via the input", async () => {
      const { service, runtime } = createMocks();

      // Cast lets us simulate a misuse — service should still pin to the definition's name.
      await service.createInstanceFor(orderDefinition, {
        metadata: {},
        // @ts-expect-error -- workflowName is Omit-stripped from the input type
        workflowName: "wrong",
      });

      expect(runtime.createInstance).toHaveBeenCalledWith(expect.objectContaining({ workflowName: "order" }));
    });
  });

  describe("triggerEventFor()", () => {
    const orderDefinition: WorkflowDefinition<"new" | "paid"> = {
      name: "order",
      initialState: "new",
      states: {
        new: { events: { Pay: { targetState: "paid" } } },
        paid: {},
      },
    };

    it("delegates to runtime.triggerEvent with the supplied input", async () => {
      const { service, runtime } = createMocks();
      const input = { workflowInstanceUuid: "u1", eventName: "Pay" };

      await service.triggerEventFor(orderDefinition, input);

      expect(runtime.triggerEvent).toHaveBeenCalledWith(input);
    });

    it("returns the runtime result unchanged at runtime (narrowing is type-only)", async () => {
      const { service, runtime } = createMocks();
      const runtimeResult = { outcome: "success", fromState: "new", toState: "paid" };
      runtime.triggerEvent.mockResolvedValueOnce(runtimeResult);

      const result = await service.triggerEventFor(orderDefinition, {
        workflowInstanceUuid: "u1",
        eventName: "Pay",
      });

      expect(result).toBe(runtimeResult);
    });
  });
});
