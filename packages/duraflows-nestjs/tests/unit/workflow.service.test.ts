import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkflowService } from "../../src/services/workflow.service.js";
import { WorkflowHandle } from "@duraflows/core";

function createMocks() {
  const runtime = {
    createInstance: vi.fn().mockResolvedValue({ uuid: "new-uuid", currentState: "start" }),
    triggerEvent: vi.fn().mockResolvedValue({ outcome: "success", toState: "done" }),
    getAvailableEvents: vi.fn().mockResolvedValue([{ eventName: "Go" }]),
  };

  const instanceStore = {
    findByUuid: vi.fn().mockResolvedValue({ uuid: "inst-uuid", currentState: "pending" }),
  };

  const historyStore = {
    findByInstanceUuid: vi.fn().mockResolvedValue([{ eventName: "Created" }]),
  };

  const service = new WorkflowService(runtime as any, instanceStore as any, historyStore as any);

  return { service, runtime, instanceStore, historyStore };
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

  it("getInstance() queries instanceStore directly", async () => {
    const { service, instanceStore } = createMocks();

    const result = await service.getInstance("inst-uuid");

    expect(instanceStore.findByUuid).toHaveBeenCalledWith("inst-uuid");
    expect(result!.uuid).toBe("inst-uuid");
  });

  it("getHistory() queries historyStore with pagination", async () => {
    const { service, historyStore } = createMocks();

    const result = await service.getHistory("inst-uuid", { limit: 10, offset: 5 });

    expect(historyStore.findByInstanceUuid).toHaveBeenCalledWith("inst-uuid", {
      limit: 10,
      offset: 5,
    });
    expect(result).toHaveLength(1);
  });

  it("getHistory() works without pagination options", async () => {
    const { service, historyStore } = createMocks();

    await service.getHistory("inst-uuid");

    expect(historyStore.findByInstanceUuid).toHaveBeenCalledWith("inst-uuid", undefined);
  });

  it("getHandle() returns a WorkflowHandle with the correct uuid", () => {
    const { service } = createMocks();

    const handle = service.getHandle("my-uuid");

    expect(handle).toBeInstanceOf(WorkflowHandle);
    expect(handle.uuid).toBe("my-uuid");
  });
});
