import { describe, it, expect, vi } from "vitest";
import { Logger, type ArgumentsHost } from "@nestjs/common";
import { WorkflowError, WorkflowInstanceNotFoundError, InvalidEventError } from "@duraflows/core";
import { WorkflowExceptionFilter } from "../../src/filters/workflow-exception.filter.js";

// The filter must stay platform-agnostic: it may only call `.status(...).send(...)`,
// which exists on both Express and Fastify replies (`.json()` is Express-only).
function mockHost() {
  const send = vi.fn();
  const status = vi.fn().mockReturnValue({ send });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, send };
}

describe("WorkflowExceptionFilter", () => {
  it("maps WorkflowInstanceNotFoundError to 404", () => {
    const { host, status, send } = mockHost();
    new WorkflowExceptionFilter().catch(new WorkflowInstanceNotFoundError("abc"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(send).toHaveBeenCalledWith({
      statusCode: 404,
      error: "Not Found",
      message: 'Workflow instance "abc" not found',
    });
  });

  it("maps InvalidEventError to 409", () => {
    const { host, status, send } = mockHost();
    new WorkflowExceptionFilter().catch(new InvalidEventError("abc", "draft", "approve"), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, error: "Conflict" }));
  });

  it("maps any other WorkflowError to a generic 500 without leaking the message", () => {
    const { host, status, send } = mockHost();
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    try {
      new WorkflowExceptionFilter().catch(new WorkflowError("internal detail: uuid xyz"), host);
    } finally {
      errorSpy.mockRestore();
    }
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal server error",
    });
  });

  it("logs the underlying error on the generic 500 path", () => {
    const { host } = mockHost();
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    try {
      new WorkflowExceptionFilter().catch(new WorkflowError("optimistic locking failure: xyz"), host);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toBe("optimistic locking failure: xyz");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not log on the mapped 404/409 paths", () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    try {
      const { host } = mockHost();
      new WorkflowExceptionFilter().catch(new WorkflowInstanceNotFoundError("abc"), host);
      new WorkflowExceptionFilter().catch(new InvalidEventError("abc", "draft", "approve"), host);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
