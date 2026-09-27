import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { WorkflowRuntime } from "@duraflows/core";
import { WorkflowTimeoutService } from "../../src/services/workflow-timeout.service.js";

function createMocks() {
  const runtime = {
    processExpiredWorkflows: vi.fn().mockResolvedValue({ processed: 5, rejected: 0, businessFailed: [], failed: [] }),
    findParkedTimeouts: vi.fn().mockResolvedValue([{ uuid: "parked-1" }]),
    rearmTimeout: vi.fn().mockResolvedValue({ uuid: "parked-1", timeoutRetry: null }),
  };

  const service = new WorkflowTimeoutService(runtime as unknown as WorkflowRuntime);

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

  it("delegates findParkedTimeouts to the runtime", async () => {
    const { service, runtime } = createMocks();

    const result = await service.findParkedTimeouts({ limit: 10, workflowName: "order" });

    expect(runtime.findParkedTimeouts).toHaveBeenCalledWith({ limit: 10, workflowName: "order" });
    expect(result).toEqual([{ uuid: "parked-1" }]);
  });

  it("delegates rearmTimeout to the runtime", async () => {
    const { service, runtime } = createMocks();

    const result = await service.rearmTimeout("parked-1");

    expect(runtime.rearmTimeout).toHaveBeenCalledWith("parked-1");
    expect(result.timeoutRetry).toBeNull();
  });
});
