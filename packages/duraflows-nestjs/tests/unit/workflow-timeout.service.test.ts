import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkflowTimeoutService } from "../../src/services/workflow-timeout.service.js";

function createMocks() {
  const runtime = {
    processExpiredWorkflows: vi.fn().mockResolvedValue({ processed: 5, failed: [] }),
  };

  const service = new WorkflowTimeoutService(runtime as any);

  return { service, runtime };
}

describe("WorkflowTimeoutService", () => {
  it("delegates to runtime with limit", async () => {
    const { service, runtime } = createMocks();

    const result = await service.processExpiredWorkflows(50);

    expect(runtime.processExpiredWorkflows).toHaveBeenCalledWith({ limit: 50 });
    expect(result.processed).toBe(5);
    expect(result.failed).toEqual([]);
  });

  it("delegates to runtime without limit", async () => {
    const { service, runtime } = createMocks();

    await service.processExpiredWorkflows();

    expect(runtime.processExpiredWorkflows).toHaveBeenCalledWith({ limit: undefined });
  });
});
