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

  it("validates transaction mode on event and entry command references without a command registry", () => {
    const def = validDefinition();
    def.states.pending.events!.approve.commands = [{ name: "work", transactional: "yes" as unknown as boolean }];
    def.states.approved.onEnter = { commands: [{ name: "work", transactional: 1 as unknown as boolean }] };
    expect(validator.validate(def).errors.map((e) => e.path)).toEqual([
      "states.pending.events.approve.commands[0].transactional",
      "states.approved.onEnter.commands[0].transactional",
    ]);
    def.states.pending.events!.approve.commands[0].transactional = true;
    def.states.approved.onEnter.commands![0].transactional = false;
    expect(validator.validate(def).valid).toBe(true);
  });

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

  it("returns an error when the initial state is an inherited Object.prototype name", () => {
    const def = validDefinition();
    def.initialState = "constructor";

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ path: "initialState" }));
  });

  it.each([
    ["event targetState", { events: { go: { targetState: "toString" } } }, "states.start.events.go.targetState"],
    [
      "event errorState",
      { events: { go: { targetState: "end", errorState: "valueOf", commands: [{ name: "c" }] } } },
      "states.start.events.go.errorState",
    ],
    ["onEnter targetState", { onEnter: { targetState: "toString" } }, "states.start.onEnter.targetState"],
    [
      "onEnter errorState",
      { onEnter: { errorState: "hasOwnProperty", commands: [{ name: "c" }] } },
      "states.start.onEnter.errorState",
    ],
  ])("returns an error when an %s names an inherited Object.prototype property", (_label, start, path) => {
    const def: WorkflowDefinition = {
      name: "inherited-state-names",
      initialState: "start",
      states: { start, end: {} } as WorkflowDefinition["states"],
    };

    const result = validator.validate(def);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ path }));
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite timeout value %s",
    (value) => {
      const definition: WorkflowDefinition = {
        name: "timeout-validation-wf",
        initialState: "waiting",
        states: {
          waiting: {
            events: {
              expire: { targetState: "expired", timeout: { afterMinutes: value } },
            },
          },
          expired: {},
        },
      };

      const result = validator.validate(definition);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: expect.stringContaining("afterMinutes"),
          message: expect.stringContaining("positive finite number"),
        }),
      );
    },
  );

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

  it("flags an event whose guard ref is not in knownGuardNames", () => {
    const validator = new WorkflowValidator();
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "missingGuard" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const result = validator.validate(definition, {
      knownCommandNames: new Set(),
      knownGuardNames: new Set(),
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "states.draft.events.submit.guard",
        message: 'Guard "missingGuard" is not registered',
      },
    ]);
  });

  it("accepts a guard ref that resolves in knownGuardNames", () => {
    const validator = new WorkflowValidator();
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const result = validator.validate(definition, {
      knownCommandNames: new Set(),
      knownGuardNames: new Set(["isVerified"]),
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("does not validate guard refs when knownGuardNames is not provided", () => {
    // Mirrors how command-ref validation works: only enforced when the option is supplied.
    const validator = new WorkflowValidator();
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "anyGuard" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const result = validator.validate(definition, {});

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // --- unreachable state detection ---

  describe("unreachable state detection", () => {
    it("warns about states unreachable from the initial state", () => {
      const result = new WorkflowValidator().validate({
        name: "wf",
        initialState: "a",
        states: {
          a: { events: { go: { targetState: "b" } } },
          b: {},
          orphan: {},
        },
      });
      expect(result.valid).toBe(true); // warnings do not fail validation
      expect(result.warnings).toEqual([
        {
          path: "states.orphan",
          message: 'State "orphan" is unreachable from initial state "a"',
        },
      ]);
    });

    it("treats onEnter targets and errorStates as reachable", () => {
      const result = new WorkflowValidator().validate({
        name: "wf",
        initialState: "a",
        states: {
          a: { onEnter: { commands: [{ name: "x" }], targetState: "b", errorState: "c" } },
          b: {},
          c: {},
        },
      });
      expect(result.warnings).toEqual([]);
    });
  });

  it('rejects event names starting with "$" as reserved', () => {
    const result = new WorkflowValidator().validate({
      name: "wf",
      initialState: "a",
      states: { a: { events: { $migrated: { targetState: "b" } } }, b: {} },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: "states.a.events.$migrated",
      message: 'Event names starting with "$" are reserved',
    });
  });

  it('accepts a "$" that is not the first character of an event name', () => {
    const result = new WorkflowValidator().validate({
      name: "wf",
      initialState: "a",
      states: { a: { events: { pay$: { targetState: "b" } } }, b: {} },
    });
    expect(result.valid).toBe(true);
  });
});
