import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import { WorkflowDefinitionError } from "../../src/errors/index.js";

describe("WorkflowCompiler", () => {
  let compiler: WorkflowCompiler;

  beforeEach(() => {
    compiler = new WorkflowCompiler();
  });

  function simpleDefinition(): WorkflowDefinition {
    return {
      name: "order",
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

  it("compiles a simple definition and returns a CompiledWorkflow with a process", () => {
    const definition = simpleDefinition();
    const compiled = compiler.compile(definition);

    expect(compiled).toBeDefined();
    expect(compiled.definition).toBe(definition);
    expect(compiled.process).toBeDefined();
  });

  it("compiled process has the correct initial state", () => {
    const definition = simpleDefinition();
    const compiled = compiler.compile(definition);

    expect(compiled.process.getInitialState().getName()).toBe("pending");
  });

  it("creates a success transition when targetState is defined", () => {
    const definition: WorkflowDefinition = {
      name: "order",
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

    const compiled = compiler.compile(definition);
    const pendingState = compiled.process.getState("pending");
    const transitions = [...pendingState.getTransitions()];

    expect(transitions).toHaveLength(1);
    expect(transitions[0].getTargetState().getName()).toBe("approved");
    expect(transitions[0].getEventName()).toBe("approve");
    expect(transitions[0].getConditionName()).toBe("workflow:success:pending:approve");
  });

  it("creates a failure transition when errorState is defined", () => {
    const definition: WorkflowDefinition = {
      name: "order",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: { errorState: "failed" },
          },
        },
        failed: {},
      },
    };

    const compiled = compiler.compile(definition);
    const pendingState = compiled.process.getState("pending");
    const transitions = [...pendingState.getTransitions()];

    expect(transitions).toHaveLength(1);
    expect(transitions[0].getTargetState().getName()).toBe("failed");
    expect(transitions[0].getEventName()).toBe("approve");
    expect(transitions[0].getConditionName()).toBe("workflow:failure:pending:approve");
  });

  it("creates both transitions when both targetState and errorState are defined", () => {
    const definition: WorkflowDefinition = {
      name: "order",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: { targetState: "approved", errorState: "failed" },
          },
        },
        approved: {},
        failed: {},
      },
    };

    const compiled = compiler.compile(definition);
    const pendingState = compiled.process.getState("pending");
    const transitions = [...pendingState.getTransitions()];

    expect(transitions).toHaveLength(2);

    const successTransition = transitions.find((t) => t.getConditionName() === "workflow:success:pending:approve");
    const failureTransition = transitions.find((t) => t.getConditionName() === "workflow:failure:pending:approve");

    expect(successTransition).toBeDefined();
    expect(successTransition!.getTargetState().getName()).toBe("approved");

    expect(failureTransition).toBeDefined();
    expect(failureTransition!.getTargetState().getName()).toBe("failed");
  });

  it("returns the same cached object for the same definition", () => {
    const definition = simpleDefinition();
    const first = compiler.compile(definition);
    const second = compiler.compile(definition);

    expect(second).toBe(first);
  });

  it("invalidates cache when definition changes (same name, different states)", () => {
    const definition1: WorkflowDefinition = {
      name: "order",
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

    const first = compiler.compile(definition1);

    const definition2: WorkflowDefinition = {
      name: "order",
      initialState: "pending",
      states: {
        pending: {
          events: {
            submit: { targetState: "submitted" },
          },
        },
        submitted: {},
      },
    };

    const second = compiler.compile(definition2);

    expect(second).not.toBe(first);
    expect(second.definition).toBe(definition2);
  });

  it("throws WorkflowDefinitionError for non-existent target state", () => {
    const definition: WorkflowDefinition = {
      name: "order",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: { targetState: "nonexistent" },
          },
        },
      },
    };

    expect(() => compiler.compile(definition)).toThrow(WorkflowDefinitionError);
    expect(() => compiler.compile(definition)).toThrow(/unknownTarget.*nonexistent/);
  });

  it("throws WorkflowDefinitionError for non-existent error state", () => {
    const definition: WorkflowDefinition = {
      name: "order",
      initialState: "pending",
      states: {
        pending: {
          events: {
            approve: { errorState: "nonexistent" },
          },
        },
      },
    };

    expect(() => compiler.compile(definition)).toThrow(WorkflowDefinitionError);
    expect(() => compiler.compile(definition)).toThrow(/unknownTarget.*nonexistent/);
  });

  it("registers states only reachable via onEnter in the finita process", () => {
    const definition: WorkflowDefinition = {
      name: "order",
      initialState: "pending",
      states: {
        pending: {
          events: {
            pay: { targetState: "paid" },
          },
        },
        paid: {
          onEnter: {
            targetState: "ready_to_ship",
            commands: [{ name: "allocate-inventory" }],
          },
        },
        ready_to_ship: {
          events: {
            ship: { targetState: "shipped" },
          },
        },
        shipped: {},
      },
    };

    const compiled = compiler.compile(definition);

    expect(compiled.process.hasState("pending")).toBe(true);
    expect(compiled.process.hasState("paid")).toBe(true);
    expect(compiled.process.hasState("ready_to_ship")).toBe(true);
    expect(compiled.process.hasState("shipped")).toBe(true);
  });

  it("registers onEnter.errorState targets in the finita process", () => {
    const definition: WorkflowDefinition = {
      name: "onenter-errorstate-reachability",
      initialState: "processing",
      states: {
        processing: {
          onEnter: {
            errorState: "failed",
            commands: [{ name: "riskyWork" }],
          },
        },
        failed: {
          // reachable ONLY via processing.onEnter.errorState — no event points here
        },
      },
    };

    const compiled = compiler.compile(definition);
    expect(compiled.process.hasState("failed")).toBe(true);
  });

  it("throws WorkflowDefinitionError for non-existent initial state", () => {
    const definition: WorkflowDefinition = {
      name: "order",
      initialState: "nonexistent",
      states: {
        pending: {},
      },
    };

    expect(() => compiler.compile(definition)).toThrow(WorkflowDefinitionError);
    expect(() => compiler.compile(definition)).toThrow(/missingInitialState/);
  });
});
