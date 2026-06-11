import { describe, it, expect, vi } from "vitest";
import type { ArgumentsHost } from "@nestjs/common";
import { WorkflowError, WorkflowInstanceNotFoundError, InvalidEventError } from "@duraflows/core";
import { WorkflowExceptionFilter } from "../../src/filters/workflow-exception.filter.js";

function mockHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe("WorkflowExceptionFilter", () => {
  it("maps WorkflowInstanceNotFoundError to 404", () => {
    const { host, status, json } = mockHost();
    new WorkflowExceptionFilter().catch(new WorkflowInstanceNotFoundError("abc"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      error: "Not Found",
      message: 'Workflow instance "abc" not found',
    });
  });

  it("maps InvalidEventError to 409", () => {
    const { host, status, json } = mockHost();
    new WorkflowExceptionFilter().catch(new InvalidEventError("abc", "draft", "approve"), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, error: "Conflict" }));
  });

  it("maps any other WorkflowError to a generic 500 without leaking the message", () => {
    const { host, status, json } = mockHost();
    new WorkflowExceptionFilter().catch(new WorkflowError("internal detail: uuid xyz"), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal server error",
    });
  });
});
