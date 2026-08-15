import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { WorkflowInstanceController } from "../../src/controllers/workflow-instance.controller.js";
import type { CreateInstanceDto } from "../../src/controllers/dto/index.js";
import type { WorkflowService } from "../../src/services/workflow.service.js";

function createMocks() {
  const workflowService = {
    createInstance: vi.fn().mockResolvedValue({
      uuid: "inst-uuid",
      workflowName: "order",
      currentState: "pending",
    }),
    getInstance: vi.fn().mockResolvedValue({
      uuid: "inst-uuid",
      workflowName: "order",
      currentState: "pending",
    }),
  };

  const controller = new WorkflowInstanceController(workflowService as unknown as WorkflowService);

  return { controller, workflowService };
}

describe("WorkflowInstanceController", () => {
  it("createInstance() delegates to workflowService.createInstance()", async () => {
    const { controller, workflowService } = createMocks();
    const body = {
      workflowName: "order",
      context: { orderId: "ORD-001" },
      metadata: { source: "api" },
      triggerMetadata: { actor: "user-1" },
    };

    const result = await controller.createInstance(body as CreateInstanceDto);

    expect(workflowService.createInstance).toHaveBeenCalledWith({
      workflowName: "order",
      context: { orderId: "ORD-001" },
      metadata: { source: "api" },
      triggerMetadata: { actor: "user-1" },
    });
    expect(result.uuid).toBe("inst-uuid");
  });

  it("createInstance() passes undefined for optional fields", async () => {
    const { controller, workflowService } = createMocks();
    const body = { workflowName: "order" };

    await controller.createInstance(body as CreateInstanceDto);

    expect(workflowService.createInstance).toHaveBeenCalledWith({
      workflowName: "order",
      context: undefined,
      metadata: undefined,
      triggerMetadata: undefined,
    });
  });

  it("getInstance() returns instance when found", async () => {
    const { controller } = createMocks();

    const result = await controller.getInstance("inst-uuid");

    expect(result.uuid).toBe("inst-uuid");
  });

  it("getInstance() throws NotFoundException when instance is null", async () => {
    const { controller, workflowService } = createMocks();
    workflowService.getInstance.mockResolvedValue(null);

    await expect(controller.getInstance("missing-uuid")).rejects.toThrow(NotFoundException);
  });
});
