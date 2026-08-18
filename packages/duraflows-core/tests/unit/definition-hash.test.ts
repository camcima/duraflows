import { describe, it, expect } from "vitest";
import { computeDefinitionHash } from "../../src/util/definition-hash.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";

const baseDefinition: WorkflowDefinition = {
  name: "order",
  initialState: "new",
  states: {
    new: {
      events: {
        Submit: { targetState: "submitted", commands: [{ name: "createOrder" }] },
      },
    },
    submitted: {},
  },
};

describe("computeDefinitionHash", () => {
  it("returns a sha256-prefixed hex digest", () => {
    expect(computeDefinitionHash(baseDefinition)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for the same definition", () => {
    expect(computeDefinitionHash(baseDefinition)).toBe(computeDefinitionHash(baseDefinition));
  });

  it("is insensitive to object key order at every nesting level", () => {
    const reordered: WorkflowDefinition = {
      states: {
        submitted: {},
        new: {
          events: {
            Submit: { commands: [{ name: "createOrder" }], targetState: "submitted" },
          },
        },
      },
      initialState: "new",
      name: "order",
    };
    expect(computeDefinitionHash(reordered)).toBe(computeDefinitionHash(baseDefinition));
  });

  it("excludes the version field from the hash", () => {
    const versioned = { ...baseDefinition, version: 7 };
    expect(computeDefinitionHash(versioned)).toBe(computeDefinitionHash(baseDefinition));
  });

  it("excludes the (future) versionPolicy field from the hash", () => {
    const withPolicy = { ...baseDefinition, versionPolicy: "latest" } as WorkflowDefinition;
    expect(computeDefinitionHash(withPolicy)).toBe(computeDefinitionHash(baseDefinition));
  });

  it("changes when content changes", () => {
    const changed: WorkflowDefinition = structuredClone(baseDefinition);
    changed.states.submitted = { context: { flag: true } };
    expect(computeDefinitionHash(changed)).not.toBe(computeDefinitionHash(baseDefinition));
  });

  it("treats an explicitly-undefined property the same as an absent one", () => {
    const withUndefined = { ...baseDefinition, version: undefined } as WorkflowDefinition;
    expect(computeDefinitionHash(withUndefined)).toBe(computeDefinitionHash(baseDefinition));
  });

  it("preserves array order (command order is semantic)", () => {
    const twoCommands: WorkflowDefinition = structuredClone(baseDefinition);
    twoCommands.states.new.events!.Submit.commands = [{ name: "a" }, { name: "b" }];
    const swapped: WorkflowDefinition = structuredClone(baseDefinition);
    swapped.states.new.events!.Submit.commands = [{ name: "b" }, { name: "a" }];
    expect(computeDefinitionHash(twoCommands)).not.toBe(computeDefinitionHash(swapped));
  });
});
