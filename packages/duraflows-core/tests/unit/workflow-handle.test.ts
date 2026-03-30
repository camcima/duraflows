import { describe, it, expect, vi } from "vitest";
import { WorkflowHandle } from "../../src/runtime/workflow-handle.js";
import type { WorkflowRuntimeClient } from "../../src/runtime/workflow-handle.js";

function createMockClient(): WorkflowRuntimeClient {
  return {
    getInstance: vi.fn().mockResolvedValue({ uuid: "test-uuid", currentState: "pending" }),
    triggerEvent: vi.fn().mockResolvedValue({ outcome: "success", toState: "done" }),
    getAvailableEvents: vi.fn().mockResolvedValue([{ eventName: "Go" }]),
    getHistory: vi.fn().mockResolvedValue([{ eventName: "Created" }]),
  };
}

describe("WorkflowHandle", () => {
  it("exposes the uuid passed to the constructor", () => {
    const client = createMockClient();
    const handle = new WorkflowHandle("my-uuid", client);

    expect(handle.uuid).toBe("my-uuid");
  });

  it("getInstance() delegates to client with the bound uuid", async () => {
    const client = createMockClient();
    const handle = new WorkflowHandle("my-uuid", client);

    const result = await handle.getInstance();

    expect(client.getInstance).toHaveBeenCalledWith("my-uuid");
    expect(result).toEqual({ uuid: "test-uuid", currentState: "pending" });
  });

  it("triggerEvent() builds TriggerWorkflowEventInput and delegates", async () => {
    const client = createMockClient();
    const handle = new WorkflowHandle("my-uuid", client);
    const subject = { orderId: "123" };

    const result = await handle.triggerEvent("Pay", {
      subject,
      triggerMetadata: { source: "test" },
    });

    expect(client.triggerEvent).toHaveBeenCalledWith({
      workflowInstanceUuid: "my-uuid",
      eventName: "Pay",
      subject,
      triggerMetadata: { source: "test" },
    });
    expect(result.outcome).toBe("success");
  });

  it("triggerEvent() handles omitted options", async () => {
    const client = createMockClient();
    const handle = new WorkflowHandle("my-uuid", client);

    await handle.triggerEvent("Go");

    expect(client.triggerEvent).toHaveBeenCalledWith({
      workflowInstanceUuid: "my-uuid",
      eventName: "Go",
      subject: undefined,
      triggerMetadata: undefined,
    });
  });

  it("getAvailableEvents() delegates with the bound uuid", async () => {
    const client = createMockClient();
    const handle = new WorkflowHandle("my-uuid", client);

    const result = await handle.getAvailableEvents();

    expect(client.getAvailableEvents).toHaveBeenCalledWith({
      workflowInstanceUuid: "my-uuid",
    });
    expect(result).toEqual([{ eventName: "Go" }]);
  });

  it("getHistory() delegates with the bound uuid and options", async () => {
    const client = createMockClient();
    const handle = new WorkflowHandle("my-uuid", client);

    const result = await handle.getHistory({ limit: 10, offset: 5 });

    expect(client.getHistory).toHaveBeenCalledWith("my-uuid", { limit: 10, offset: 5 });
    expect(result).toEqual([{ eventName: "Created" }]);
  });

  it("getHistory() handles omitted options", async () => {
    const client = createMockClient();
    const handle = new WorkflowHandle("my-uuid", client);

    await handle.getHistory();

    expect(client.getHistory).toHaveBeenCalledWith("my-uuid", undefined);
  });
});
