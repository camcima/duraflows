import { describe, it, expect } from "vitest";
import {
  WorkflowError,
  WorkflowDefinitionError,
  InvalidEventError,
  OnEnterDepthExceededError,
  CommandFailureError,
} from "../../src/errors/index.js";

describe("WorkflowError", () => {
  it("sets message and name", () => {
    const err = new WorkflowError("something went wrong");
    expect(err.message).toBe("something went wrong");
    expect(err.name).toBe("WorkflowError");
    expect(err).toBeInstanceOf(Error);
  });

  it("chains a cause", () => {
    const cause = new Error("root cause");
    const err = new WorkflowError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new WorkflowError("no cause");
    expect(err.cause).toBeUndefined();
  });
});

describe("WorkflowDefinitionError", () => {
  it("formats message with workflow name", () => {
    const err = new WorkflowDefinitionError("order", "Initial state missing");
    expect(err.message).toBe('Workflow "order": Initial state missing');
    expect(err.name).toBe("WorkflowDefinitionError");
    expect(err.workflowName).toBe("order");
  });

  it("extends WorkflowError", () => {
    const err = new WorkflowDefinitionError("wf", "bad");
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("InvalidEventError", () => {
  it("stores all properties and formats message", () => {
    const err = new InvalidEventError("uuid-123", "pending", "Ship");
    expect(err.message).toBe(
      'Event "Ship" is not available on state "pending" for instance "uuid-123"',
    );
    expect(err.name).toBe("InvalidEventError");
    expect(err.workflowInstanceUuid).toBe("uuid-123");
    expect(err.currentState).toBe("pending");
    expect(err.eventName).toBe("Ship");
  });

  it("extends WorkflowError", () => {
    const err = new InvalidEventError("u", "s", "e");
    expect(err).toBeInstanceOf(WorkflowError);
  });
});

describe("OnEnterDepthExceededError", () => {
  it("stores all properties and formats message", () => {
    const err = new OnEnterDepthExceededError("uuid-456", "processing", 10);
    expect(err.message).toBe(
      'onEnter chain exceeded maximum depth of 10 at state "processing" for instance "uuid-456"',
    );
    expect(err.name).toBe("OnEnterDepthExceededError");
    expect(err.workflowInstanceUuid).toBe("uuid-456");
    expect(err.stateName).toBe("processing");
    expect(err.depth).toBe(10);
  });

  it("extends WorkflowError", () => {
    const err = new OnEnterDepthExceededError("u", "s", 5);
    expect(err).toBeInstanceOf(WorkflowError);
  });
});

describe("CommandFailureError", () => {
  it("stores all properties and formats message using result.message", () => {
    const result = { ok: false as const, code: "DECLINED", message: "Card declined" };
    const err = new CommandFailureError("uuid-789", "Pay", "chargePayment", result);
    expect(err.message).toBe(
      'Command "chargePayment" failed for event "Pay" on instance "uuid-789": Card declined',
    );
    expect(err.name).toBe("CommandFailureError");
    expect(err.workflowInstanceUuid).toBe("uuid-789");
    expect(err.eventName).toBe("Pay");
    expect(err.commandName).toBe("chargePayment");
    expect(err.result).toBe(result);
  });

  it("falls back to result.code when message is absent", () => {
    const result = { ok: false as const, code: "TIMEOUT" };
    const err = new CommandFailureError("u", "e", "cmd", result);
    expect(err.message).toContain("TIMEOUT");
  });

  it("falls back to 'unknown' when both message and code are absent", () => {
    const result = { ok: false as const };
    const err = new CommandFailureError("u", "e", "cmd", result);
    expect(err.message).toContain("unknown");
  });

  it("extends WorkflowError", () => {
    const err = new CommandFailureError("u", "e", "c", { ok: false });
    expect(err).toBeInstanceOf(WorkflowError);
  });
});
