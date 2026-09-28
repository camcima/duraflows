import { describe, it, expect } from "vitest";
import { terminalStates, referencedNames } from "../../src/runtime/definition-executability.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";

const definition: WorkflowDefinition = {
  name: "wf",
  initialState: "a",
  states: {
    a: { events: { Go: { targetState: "b", guard: { name: "g1" }, commands: [{ name: "c1" }, { name: "c2" }] } } },
    b: { onEnter: { targetState: "c", commands: [{ name: "c3" }, { name: "c1" }] } },
    c: {},
    d: { events: {} },
  },
};

describe("terminalStates", () => {
  it("returns states with no events and no onEnter", () => {
    expect(terminalStates(definition)).toEqual(["c", "d"]);
  });
});

describe("referencedNames", () => {
  it("collects each command and guard once, in definition order", () => {
    expect(referencedNames(definition)).toEqual({ commands: ["c1", "c2", "c3"], guards: ["g1"] });
  });
});
