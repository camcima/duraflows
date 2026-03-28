import { describe, it, expect, vi } from "vitest";
import type { WorkflowDefinition, CommandResult, WorkflowExecutionContext } from "../../src/types/index.js";
import { WorkflowError, WorkflowDefinitionError } from "../../src/errors/index.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubCommand = {
  async execute(_subject: unknown, _ctx: WorkflowExecutionContext): Promise<CommandResult> {
    return { ok: true };
  },
};

const minimalDefinition: WorkflowDefinition = {
  name: "test-wf",
  initialState: "start",
  states: { start: {} },
};

const anotherDefinition: WorkflowDefinition = {
  name: "other-wf",
  initialState: "a",
  states: { a: {} },
};

// ---------------------------------------------------------------------------
// InMemoryCommandRegistry
// ---------------------------------------------------------------------------

describe("InMemoryCommandRegistry", () => {
  it("register and get a command", () => {
    const registry = new InMemoryCommandRegistry();
    registry.register("cmd", stubCommand);
    expect(registry.get("cmd")).toBe(stubCommand);
  });

  it("has() returns true for registered command", () => {
    const registry = new InMemoryCommandRegistry();
    registry.register("cmd", stubCommand);
    expect(registry.has("cmd")).toBe(true);
  });

  it("has() returns false for unregistered command", () => {
    const registry = new InMemoryCommandRegistry();
    expect(registry.has("nope")).toBe(false);
  });

  it("throws WorkflowError on duplicate registration", () => {
    const registry = new InMemoryCommandRegistry();
    registry.register("cmd", stubCommand);
    expect(() => registry.register("cmd", stubCommand)).toThrow(WorkflowError);
    expect(() => registry.register("cmd", stubCommand)).toThrow(
      'Command "cmd" is already registered',
    );
  });

  it("throws WorkflowError when getting unknown command", () => {
    const registry = new InMemoryCommandRegistry();
    expect(() => registry.get("missing")).toThrow(WorkflowError);
    expect(() => registry.get("missing")).toThrow(
      'Command "missing" not found in registry',
    );
  });
});

// ---------------------------------------------------------------------------
// InMemoryDefinitionRegistry
// ---------------------------------------------------------------------------

describe("InMemoryDefinitionRegistry", () => {
  it("register and get a definition", () => {
    const registry = new InMemoryDefinitionRegistry();
    registry.register(minimalDefinition);
    expect(registry.get("test-wf")).toBe(minimalDefinition);
  });

  it("has() returns true for registered definition", () => {
    const registry = new InMemoryDefinitionRegistry();
    registry.register(minimalDefinition);
    expect(registry.has("test-wf")).toBe(true);
  });

  it("has() returns false for unregistered definition", () => {
    const registry = new InMemoryDefinitionRegistry();
    expect(registry.has("nope")).toBe(false);
  });

  it("getAll() returns all registered definitions", () => {
    const registry = new InMemoryDefinitionRegistry();
    registry.register(minimalDefinition);
    registry.register(anotherDefinition);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(minimalDefinition);
    expect(all).toContain(anotherDefinition);
  });

  it("getAll() returns empty array when no definitions registered", () => {
    const registry = new InMemoryDefinitionRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it("throws WorkflowDefinitionError on duplicate registration", () => {
    const registry = new InMemoryDefinitionRegistry();
    registry.register(minimalDefinition);
    expect(() => registry.register(minimalDefinition)).toThrow(WorkflowDefinitionError);
    expect(() => registry.register(minimalDefinition)).toThrow(
      "already registered",
    );
  });

  it("throws WorkflowDefinitionError when getting unknown definition", () => {
    const registry = new InMemoryDefinitionRegistry();
    expect(() => registry.get("missing")).toThrow(WorkflowDefinitionError);
    expect(() => registry.get("missing")).toThrow("not found");
  });

  it("validates definition when validator is provided", () => {
    const mockValidator = {
      validate: vi.fn().mockReturnValue({
        valid: false,
        errors: [{ path: "initialState", message: 'Initial state "missing" does not exist' }],
      }),
    };
    const registry = new InMemoryDefinitionRegistry({ validator: mockValidator });

    const badDef: WorkflowDefinition = {
      name: "bad",
      initialState: "missing",
      states: { start: {} },
    };

    expect(() => registry.register(badDef)).toThrow(WorkflowDefinitionError);
    expect(() => registry.register(badDef)).toThrow("Invalid definition");
    expect(mockValidator.validate).toHaveBeenCalled();
  });

  it("compiles definition when compiler is provided", () => {
    const mockCompiler = {
      compile: vi.fn().mockReturnValue({ definition: minimalDefinition, process: {} }),
    };
    const registry = new InMemoryDefinitionRegistry({ compiler: mockCompiler });
    registry.register(minimalDefinition);
    expect(mockCompiler.compile).toHaveBeenCalledWith(minimalDefinition);
  });

  it("skips validation and compilation when not provided", () => {
    const registry = new InMemoryDefinitionRegistry();
    // Should not throw — no validator or compiler
    registry.register(minimalDefinition);
    expect(registry.get("test-wf")).toBe(minimalDefinition);
  });

  it("passes validationOptions to validator", () => {
    const knownCommands = new Set(["cmd1"]);
    const mockValidator = {
      validate: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    };
    const registry = new InMemoryDefinitionRegistry({
      validator: mockValidator,
      validationOptions: { knownCommandNames: knownCommands },
    });

    registry.register(minimalDefinition);
    expect(mockValidator.validate).toHaveBeenCalledWith(
      minimalDefinition,
      { knownCommandNames: knownCommands },
    );
  });
});
