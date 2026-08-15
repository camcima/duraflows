import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkflowQueryController } from "../../src/controllers/workflow-query.controller.js";
import type { AvailableEventsParamsDto, HistoryParamsDto, HistoryQueryDto } from "../../src/controllers/dto/index.js";
import type { WorkflowService } from "../../src/services/workflow.service.js";

function createMocks() {
  const workflowService = {
    getAvailableEvents: vi.fn().mockResolvedValue([{ eventName: "approve" }]),
    getHistory: vi.fn().mockResolvedValue([{ eventName: "Created" }]),
  };

  const controller = new WorkflowQueryController(workflowService as unknown as WorkflowService);

  return { controller, workflowService };
}

describe("WorkflowQueryController", () => {
  it("getAvailableEvents() delegates to workflowService.getAvailableEvents()", async () => {
    const { controller, workflowService } = createMocks();

    const result = await controller.getAvailableEvents({
      workflowInstanceUuid: "uuid-1",
    } as AvailableEventsParamsDto);

    expect(workflowService.getAvailableEvents).toHaveBeenCalledWith({
      workflowInstanceUuid: "uuid-1",
    });
    expect(result).toHaveLength(1);
  });

  it("getHistory() delegates with parsed limit and offset", async () => {
    const { controller, workflowService } = createMocks();

    await controller.getHistory(
      { workflowInstanceUuid: "uuid-1" } as HistoryParamsDto,
      {
        limit: 10,
        offset: 5,
      } as HistoryQueryDto,
    );

    expect(workflowService.getHistory).toHaveBeenCalledWith("uuid-1", {
      limit: 10,
      offset: 5,
    });
  });

  it("getHistory() passes undefined when limit/offset not provided", async () => {
    const { controller, workflowService } = createMocks();

    await controller.getHistory({ workflowInstanceUuid: "uuid-1" } as HistoryParamsDto, {} as HistoryQueryDto);

    expect(workflowService.getHistory).toHaveBeenCalledWith("uuid-1", {
      limit: undefined,
      offset: undefined,
    });
  });
});
