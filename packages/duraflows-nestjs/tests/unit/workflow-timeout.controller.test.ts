import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { WorkflowTimeoutController } from "../../src/controllers/workflow-timeout.controller.js";
import { TimeoutProcessQueryDto } from "../../src/controllers/dto/index.js";
import type { WorkflowTimeoutService } from "../../src/services/workflow-timeout.service.js";

function createMocks() {
  const timeoutService = {
    processExpiredWorkflows: vi.fn().mockResolvedValue({ processed: 3, rejected: 0, businessFailed: [], failed: [] }),
  };

  const controller = new WorkflowTimeoutController(timeoutService as unknown as WorkflowTimeoutService);

  return { controller, timeoutService };
}

describe("WorkflowTimeoutController", () => {
  it("processExpired() delegates with parsed limit", async () => {
    const { controller, timeoutService } = createMocks();

    const result = await controller.processExpired({ limit: 50 } as TimeoutProcessQueryDto);

    expect(timeoutService.processExpiredWorkflows).toHaveBeenCalledWith(50);
    expect(result.processed).toBe(3);
  });

  it("processExpired() passes undefined when limit not provided", async () => {
    const { controller, timeoutService } = createMocks();

    await controller.processExpired({} as TimeoutProcessQueryDto);

    expect(timeoutService.processExpiredWorkflows).toHaveBeenCalledWith(undefined);
  });

  it("rejects limit=0", async () => {
    const { ValidationPipe } = await import("@nestjs/common");
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ limit: "0" }, { type: "query", metatype: TimeoutProcessQueryDto })).rejects.toThrow();
  });

  it("rejects unknown query fields", async () => {
    const { ValidationPipe } = await import("@nestjs/common");
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ limt: "10" }, { type: "query", metatype: TimeoutProcessQueryDto })).rejects.toThrow();
  });

  it("transforms a valid string limit to a number", async () => {
    const { ValidationPipe } = await import("@nestjs/common");
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    const result = await pipe.transform({ limit: "25" }, { type: "query", metatype: TimeoutProcessQueryDto });
    expect(result.limit).toBe(25);
  });
});
