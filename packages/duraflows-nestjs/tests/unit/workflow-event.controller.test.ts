import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkflowEventController } from "../../src/controllers/workflow-event.controller.js";
import type { TriggerEventDto } from "../../src/controllers/dto/index.js";
import type { WorkflowService } from "../../src/services/workflow.service.js";

function createMocks() {
  const workflowService = {
    triggerEvent: vi.fn().mockResolvedValue({ outcome: "success", toState: "approved" }),
  };

  const controller = new WorkflowEventController(workflowService as unknown as WorkflowService);

  return { controller, workflowService };
}

describe("WorkflowEventController", () => {
  it("triggerEvent() delegates to workflowService.triggerEvent()", async () => {
    const { controller, workflowService } = createMocks();

    const result = await controller.triggerEvent({ workflowInstanceUuid: "uuid-1", eventName: "approve" }, {
      subject: { amount: 100 },
      triggerMetadata: { actor: "admin" },
    } as TriggerEventDto);

    expect(workflowService.triggerEvent).toHaveBeenCalledWith({
      workflowInstanceUuid: "uuid-1",
      eventName: "approve",
      subject: { amount: 100 },
      triggerMetadata: { actor: "admin" },
    });
    expect(result.outcome).toBe("success");
  });

  it("triggerEvent() passes undefined for optional body fields", async () => {
    const { controller, workflowService } = createMocks();

    await controller.triggerEvent({ workflowInstanceUuid: "uuid-1", eventName: "approve" }, {} as TriggerEventDto);

    expect(workflowService.triggerEvent).toHaveBeenCalledWith({
      workflowInstanceUuid: "uuid-1",
      eventName: "approve",
      subject: undefined,
      triggerMetadata: undefined,
    });
  });
});
