import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkflowTimeoutController } from "../../src/controllers/workflow-timeout.controller.js";

function createMocks() {
  const timeoutService = {
    processExpiredWorkflows: vi.fn().mockResolvedValue({ processed: 3, rejected: 0, failed: [] }),
  };

  const controller = new WorkflowTimeoutController(timeoutService as any);

  return { controller, timeoutService };
}

describe("WorkflowTimeoutController", () => {
  it("processExpired() delegates with parsed limit", async () => {
    const { controller, timeoutService } = createMocks();

    const result = await controller.processExpired({ limit: "50" } as any);

    expect(timeoutService.processExpiredWorkflows).toHaveBeenCalledWith(50);
    expect(result.processed).toBe(3);
  });

  it("processExpired() passes undefined when limit not provided", async () => {
    const { controller, timeoutService } = createMocks();

    await controller.processExpired({} as any);

    expect(timeoutService.processExpiredWorkflows).toHaveBeenCalledWith(undefined);
  });
});
