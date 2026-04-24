import { describe, it, expect } from "vitest";
import { WorkflowValidator } from "../../src/validation/workflow-validator.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";

function validDefinition(): WorkflowDefinition {
  return {
    name: "order-workflow",
    initialState: "pending",
    states: {
      pending: {
        events: {
          approve: { targetState: "approved" },
        },
      },
      approved: {},
    },
  };
}

describe("WorkflowValidator", () => {
  const validator = new WorkflowValidator();

  it("returns valid:true for a valid definition with states and events", () => {
    const result = validator.validate(validDefinition());

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns an error when name is empty", () => {
    const def = validDefinition();
    def.name = "";

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: "name", message: expect.stringContaining("non-empty") }),
    );
  });

  it("returns an error when initial state does not exist in states", () => {
    const def = validDefinition();
    def.initialState = "nonexistent";

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "initialState",
        message: expect.stringContaining("nonexistent"),
      }),
    );
  });

  it("returns an error when no states are defined", () => {
    const def: WorkflowDefinition = {
      name: "empty-workflow",
      initialState: "start",
      states: {},
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: "states", message: expect.stringContaining("at least one") }),
    );
  });

  it("returns an error when targetState references a non-existent state", () => {
    const def = validDefinition();
    def.states["pending"]!.events!["approve"]!.targetState = "ghost";

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states.pending.events.approve.targetState",
        message: expect.stringContaining("ghost"),
      }),
    );
  });

  it("returns an error when errorState references a non-existent state", () => {
    const def = validDefinition();
    def.states["pending"]!.events!["approve"]!.errorState = "nowhere";

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states.pending.events.approve.errorState",
        message: expect.stringContaining("nowhere"),
      }),
    );
  });

  it("accepts an event with only commands (no state change on success)", () => {
    const definition: WorkflowDefinition = {
      name: "command-only-event",
      initialState: "ready",
      states: {
        ready: {
          events: {
            ping: {
              commands: [{ name: "emitPing" }],
            },
          },
        },
      },
    };

    const result = validator.validate(definition, { knownCommandNames: new Set(["emitPing"]) });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts an event with only errorState (failure-only transition)", () => {
    const definition: WorkflowDefinition = {
      name: "error-only-event",
      initialState: "ready",
      states: {
        ready: {
          events: {
            process: {
              errorState: "failed",
              commands: [{ name: "risky" }],
            },
          },
        },
        failed: {},
      },
    };

    const result = validator.validate(definition, { knownCommandNames: new Set(["risky"]) });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a completely empty event (no targetState, no errorState, no commands)", () => {
    const definition: WorkflowDefinition = {
      name: "empty-event",
      initialState: "ready",
      states: {
        ready: {
          events: {
            noop: {},
          },
        },
      },
    };

    const result = validator.validate(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("targetState, errorState, or commands"))).toBe(true);
  });

  it("returns an error when a state has multiple events with timeouts", () => {
    const def: WorkflowDefinition = {
      name: "order-workflow",
      initialState: "pending",
      states: {
        pending: {
          events: {
            timeout1: { targetState: "expired", timeout: { afterMinutes: 30 } },
            timeout2: { targetState: "expired", timeout: { afterHours: 1 } },
          },
        },
        expired: {},
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states.pending",
        message: expect.stringContaining("one event per state"),
      }),
    );
  });

  it("returns an error when a timeout has non-positive values", () => {
    const def: WorkflowDefinition = {
      name: "order-workflow",
      initialState: "pending",
      states: {
        pending: {
          events: {
            expire: { targetState: "expired", timeout: { afterMinutes: 0 } },
          },
        },
        expired: {},
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states.pending.events.expire.timeout.afterMinutes",
        message: expect.stringContaining("positive"),
      }),
    );
  });

  it("returns an error when a timeout has no duration fields", () => {
    const def: WorkflowDefinition = {
      name: "order-workflow",
      initialState: "pending",
      states: {
        pending: {
          events: {
            expire: { targetState: "expired", timeout: {} },
          },
        },
        expired: {},
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states.pending.events.expire.timeout",
        message: expect.stringContaining("at least one duration"),
      }),
    );
  });

  it("returns an error when a command name is not in knownCommandNames", () => {
    const def: WorkflowDefinition = {
      name: "order-workflow",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: {
              targetState: "approved",
              commands: [{ name: "SendEmail" }, { name: "UnknownCmd" }],
            },
          },
        },
        approved: {},
      },
    };

    const result = validator.validate(def, {
      knownCommandNames: new Set(["SendEmail"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        path: "states.pending.events.approve.commands[1]",
        message: expect.stringContaining("UnknownCmd"),
      }),
    );
  });

  it("passes validation when all command names are in knownCommandNames", () => {
    const def: WorkflowDefinition = {
      name: "order-workflow",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: {
              targetState: "approved",
              commands: [{ name: "SendEmail" }, { name: "NotifySlack" }],
            },
          },
        },
        approved: {},
      },
    };

    const result = validator.validate(def, {
      knownCommandNames: new Set(["SendEmail", "NotifySlack"]),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does not validate command names when knownCommandNames is not provided", () => {
    const def: WorkflowDefinition = {
      name: "order-workflow",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: {
              targetState: "approved",
              commands: [{ name: "AnythingGoes" }],
            },
          },
        },
        approved: {},
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // --- onEnter validation ---

  it("passes validation for a valid onEnter with targetState", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "b", commands: [{ name: "cmd1" }] },
        },
        b: {},
      },
    };

    const result = validator.validate(def, {
      knownCommandNames: new Set(["cmd1"]),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns an error when onEnter.targetState references a non-existent state", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "ghost" },
        },
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states.a.onEnter.targetState",
        message: expect.stringContaining("ghost"),
      }),
    );
  });

  it("returns an error when onEnter.errorState references a non-existent state", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "b", errorState: "nowhere" },
        },
        b: {},
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states.a.onEnter.errorState",
        message: expect.stringContaining("nowhere"),
      }),
    );
  });

  it("returns an error when onEnter command name is not in knownCommandNames", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { commands: [{ name: "known" }, { name: "unknown" }] },
        },
        b: {},
      },
    };

    const result = validator.validate(def, {
      knownCommandNames: new Set(["known"]),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        path: "states.a.onEnter.commands[1]",
        message: expect.stringContaining("unknown"),
      }),
    );
  });

  it("detects a direct onEnter cycle (A -> A)", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "a" },
        },
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states",
        message: expect.stringContaining("Cycle"),
      }),
    );
  });

  it("detects an indirect onEnter cycle (A -> B -> A)", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "b" },
        },
        b: {
          onEnter: { targetState: "a" },
        },
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states",
        message: expect.stringContaining("Cycle"),
      }),
    );
  });

  it("detects a cycle through errorState", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "b", errorState: "c" },
        },
        b: {},
        c: {
          onEnter: { targetState: "a" },
        },
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "states",
        message: expect.stringContaining("Cycle"),
      }),
    );
  });

  it("passes validation for an acyclic onEnter chain", () => {
    const def: WorkflowDefinition = {
      name: "wf",
      initialState: "a",
      states: {
        a: {
          onEnter: { targetState: "b" },
        },
        b: {
          onEnter: { targetState: "c" },
        },
        c: {},
      },
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
