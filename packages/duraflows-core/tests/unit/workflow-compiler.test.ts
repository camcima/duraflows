import { describe, it, expect, beforeEach, vi } from "vitest";
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

  it("translates FinitaError from ProcessBuilder as WorkflowDefinitionError", () => {
    // Event name with leading whitespace trips v3's invalidEventName validation
    // inside ProcessBuilder. The compiler must wrap that as WorkflowDefinitionError
    // so the public error contract stays stable.
    const definition: WorkflowDefinition = {
      name: "whitespace-event",
      initialState: "pending",
      states: {
        pending: {
          events: {
            " submit": { targetState: "submitted" },
          },
        },
        submitted: {},
      },
    };

    expect(() => compiler.compile(definition)).toThrow(WorkflowDefinitionError);
    expect(() => compiler.compile(definition)).toThrow(/submit/);
  });

  it("merges target/error transitions when both lead to the same state", () => {
    // Same state for both branches is a valid pattern (e.g., "go to 'done'
    // regardless of outcome, but record success vs failure in history").
    // ProcessBuilder rejects duplicate (from, event, to) with conflicting
    // conditions, so the compiler must collapse the two branches into one
    // transition with a permissive condition.
    const definition: WorkflowDefinition = {
      name: "merged-target",
      initialState: "pending",
      states: {
        pending: {
          events: {
            finalise: { targetState: "done", errorState: "done" },
          },
        },
        done: {},
      },
    };

    const compiled = compiler.compile(definition);
    expect(compiled.process.hasState("done")).toBe(true);

    // Confirm exactly one transition was registered for the event (not two).
    const pending = compiled.process.getState("pending");
    const transitions = Array.from(pending.getTransitions()).filter((t) => t.getEventName() === "finalise");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].getTargetState().getName()).toBe("done");
  });

  it("does not re-serialize the definition when compiling the same object again", () => {
    // compile() runs on every triggerEvent. Definitions are frozen at
    // registration, so repeat calls arrive with a stable object identity —
    // hashing them again on each event is pure overhead on the hot path.
    const definition = simpleDefinition();
    compiler.compile(definition);

    const stringifySpy = vi.spyOn(JSON, "stringify");
    try {
      const second = compiler.compile(definition);
      expect(second).toBe(compiler.compile(definition));
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it("reuses the cached process for an equal definition with a different identity", () => {
    // WorkflowCompiler is public API: a caller outside the registry may hand
    // it a fresh-but-equal object each call. Identity caching alone would
    // recompile every time, so the name+hash cache stays as the fallback.
    const first = compiler.compile(simpleDefinition());
    const second = compiler.compile(simpleDefinition());

    expect(second).toBe(first);
  });
});
