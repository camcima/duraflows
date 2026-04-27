import { describe, it, expect, vi } from "vitest";
import type { WorkflowDefinition, CommandResult, WorkflowExecutionContext, WorkflowGuard } from "../../src/index.js";
import { WorkflowError, WorkflowDefinitionError } from "../../src/errors/index.js";
import { InMemoryCommandRegistry } from "../../src/registry/command-registry.js";
import { InMemoryDefinitionRegistry } from "../../src/registry/definition-registry.js";
import { InMemoryGuardRegistry } from "../../src/registry/guard-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubCommand = {
  async execute(_subject: unknown, _ctx: WorkflowExecutionContext): Promise<CommandResult> {
    return { ok: true };
  },
};

const stubGuard: WorkflowGuard = {
  name: "stub",
  evaluate(_subject: unknown, _ctx: WorkflowExecutionContext): boolean {
    return true;
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
    expect(() => registry.register("cmd", stubCommand)).toThrow('Command "cmd" is already registered');
  });

  it("throws WorkflowError when getting unknown command", () => {
    const registry = new InMemoryCommandRegistry();
    expect(() => registry.get("missing")).toThrow(WorkflowError);
    expect(() => registry.get("missing")).toThrow('Command "missing" not found in registry');
  });
});

// ---------------------------------------------------------------------------
// InMemoryGuardRegistry
// ---------------------------------------------------------------------------

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
    const act = () => registry.register("stub", stubGuard);
    expect(act).toThrow(WorkflowError);
    expect(act).toThrow('Guard "stub" is already registered');
  });

  it("throws WorkflowError when getting unknown guard", () => {
    const registry = new InMemoryGuardRegistry();
    const act = () => registry.get("missing");
    expect(act).toThrow(WorkflowError);
    expect(act).toThrow('Guard "missing" not found in registry');
  });
});

// ---------------------------------------------------------------------------
// InMemoryDefinitionRegistry
// ---------------------------------------------------------------------------

describe("InMemoryDefinitionRegistry", () => {
  it("register and get a definition", () => {
    const registry = new InMemoryDefinitionRegistry();
    registry.register(minimalDefinition);
    expect(registry.get("test-wf")).toEqual(minimalDefinition);
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
    expect(all).toContainEqual(minimalDefinition);
    expect(all).toContainEqual(anotherDefinition);
  });

  it("getAll() returns empty array when no definitions registered", () => {
    const registry = new InMemoryDefinitionRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it("throws WorkflowDefinitionError on duplicate registration", () => {
    const registry = new InMemoryDefinitionRegistry();
    registry.register(minimalDefinition);
    expect(() => registry.register(minimalDefinition)).toThrow(WorkflowDefinitionError);
    expect(() => registry.register(minimalDefinition)).toThrow("already registered");
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
    expect(mockCompiler.compile).toHaveBeenCalledWith(expect.objectContaining({ name: "test-wf" }));
  });

  it("skips validation and compilation when not provided", () => {
    const registry = new InMemoryDefinitionRegistry();
    // Should not throw — no validator or compiler
    registry.register(minimalDefinition);
    expect(registry.get("test-wf")).toEqual(minimalDefinition);
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
    expect(mockValidator.validate).toHaveBeenCalledWith(expect.objectContaining({ name: "test-wf" }), {
      knownCommandNames: knownCommands,
    });
  });

  it("register stores a deep clone — post-registration caller mutations do not affect stored definition", () => {
    const registry = new InMemoryDefinitionRegistry();
    const definition: WorkflowDefinition = {
      name: "mutation-isolation",
      initialState: "ready",
      states: {
        ready: {
          context: { policy: { retries: 3 } },
          events: {
            go: { targetState: "done" },
          },
        },
        done: {},
      },
    };

    registry.register(definition);

    // Caller mutates their local reference after registration
    (definition.states.ready.context!.policy as { retries: number }).retries = 99;
    definition.states.done.events = { bogus: { targetState: "ready" } };

    const stored = registry.get("mutation-isolation");
    expect((stored.states.ready.context!.policy as { retries: number }).retries).toBe(3);
    expect(stored.states.done.events).toBeUndefined();
  });

  it("the stored definition is deeply frozen", () => {
    const registry = new InMemoryDefinitionRegistry();
    const definition: WorkflowDefinition = {
      name: "frozen-definition",
      initialState: "ready",
      states: { ready: { context: { nested: { tag: "initial" } } } },
    };

    registry.register(definition);
    const stored = registry.get("frozen-definition");

    // Direct mutation attempts throw in strict mode
    expect(() => {
      (stored.states.ready.context!.nested as { tag: string }).tag = "mutated";
    }).toThrow();

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.states.ready.context!.nested)).toBe(true);
  });
});
