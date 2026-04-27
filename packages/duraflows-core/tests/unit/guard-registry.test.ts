import { describe, it, expect } from "vitest";
import { InMemoryGuardRegistry } from "../../src/registry/guard-registry.js";
import { WorkflowError } from "../../src/errors/index.js";
import type { WorkflowGuard, WorkflowExecutionContext } from "../../src/types/runtime.js";

const stubGuard: WorkflowGuard = {
  name: "stub",
  evaluate(_subject: unknown, _ctx: WorkflowExecutionContext): boolean {
    return true;
  },
};

describe("InMemoryGuardRegistry", () => {
  it("register and get a guard", () => {
    const registry = new InMemoryGuardRegistry();
    registry.register("stub", stubGuard);
    expect(registry.get("stub")).toBe(stubGuard);
  });

  it("has() returns true for registered guard", () => {
    const registry = new InMemoryGuardRegistry();
    registry.register("stub", stubGuard);
    expect(registry.has("stub")).toBe(true);
  });

  it("has() returns false for unregistered guard", () => {
    const registry = new InMemoryGuardRegistry();
    expect(registry.has("nope")).toBe(false);
  });

  it("throws WorkflowError on duplicate registration", () => {
    const registry = new InMemoryGuardRegistry();
    registry.register("stub", stubGuard);
    expect(() => registry.register("stub", stubGuard)).toThrow(WorkflowError);
    expect(() => registry.register("stub", stubGuard)).toThrow('Guard "stub" is already registered');
  });

  it("throws WorkflowError when getting unknown guard", () => {
    const registry = new InMemoryGuardRegistry();
    expect(() => registry.get("missing")).toThrow(WorkflowError);
    expect(() => registry.get("missing")).toThrow('Guard "missing" not found in registry');
  });
});
