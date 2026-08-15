import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NestCommandRegistry } from "../../src/providers/nest-command-registry.js";
import { WorkflowError, type WorkflowCommand } from "@duraflows/core";
import type { Type } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";

class StubCommandA {
  async execute() {
    return { ok: true };
  }
}

class StubCommandB {
  async execute() {
    return { ok: true };
  }
}

function createMockModuleRef(): ModuleRef {
  return {
    get: vi.fn().mockImplementation((cls: new () => unknown) => new cls()),
  } as unknown as ModuleRef;
}

describe("NestCommandRegistry", () => {
  it("has() returns true for registered command", () => {
    const moduleRef = createMockModuleRef();
    const registry = new NestCommandRegistry(moduleRef, [{ name: "cmdA", useClass: StubCommandA }]);
    expect(registry.has("cmdA")).toBe(true);
  });

  it("has() returns false for unregistered command", () => {
    const moduleRef = createMockModuleRef();
    const registry = new NestCommandRegistry(moduleRef, []);
    expect(registry.has("nope")).toBe(false);
  });

  it("get() resolves command via moduleRef", () => {
    const moduleRef = createMockModuleRef();
    const registry = new NestCommandRegistry(moduleRef, [{ name: "cmdA", useClass: StubCommandA }]);

    const cmd = registry.get("cmdA");

    expect(moduleRef.get).toHaveBeenCalledWith(StubCommandA, { strict: false });
    expect(cmd).toBeInstanceOf(StubCommandA);
  });

  it("get() throws WorkflowError for unknown command", () => {
    const moduleRef = createMockModuleRef();
    const registry = new NestCommandRegistry(moduleRef, []);

    expect(() => registry.get("missing")).toThrow(WorkflowError);
    expect(() => registry.get("missing")).toThrow("not found");
  });

  it("constructor throws WorkflowError on duplicate name", () => {
    const moduleRef = createMockModuleRef();

    expect(
      () =>
        new NestCommandRegistry(moduleRef, [
          { name: "dup", useClass: StubCommandA },
          { name: "dup", useClass: StubCommandB },
        ]),
    ).toThrow(WorkflowError);
  });

  it("getRegisteredNames() returns all registered names", () => {
    const moduleRef = createMockModuleRef();
    const registry = new NestCommandRegistry(moduleRef, [
      { name: "cmdA", useClass: StubCommandA },
      { name: "cmdB", useClass: StubCommandB },
    ]);

    const names = registry.getRegisteredNames();
    expect(names).toEqual(new Set(["cmdA", "cmdB"]));
  });

  it("works with empty registrations", () => {
    const moduleRef = createMockModuleRef();
    const registry = new NestCommandRegistry(moduleRef);

    expect(registry.getRegisteredNames()).toEqual(new Set());
    expect(registry.has("anything")).toBe(false);
  });

  it("wraps scope-resolution failures with a singleton-scope hint", () => {
    const moduleRef = {
      get: vi.fn(() => {
        throw new Error("ScopedCommand is marked as a scoped provider. Use the resolve() method instead.");
      }),
    } as unknown as ModuleRef;
    class ScopedCommand {}
    const registry = new NestCommandRegistry(moduleRef, [
      { name: "scoped", useClass: ScopedCommand as Type<WorkflowCommand> },
    ]);
    expect(() => registry.get("scoped")).toThrow(/singleton-scoped/);
  });

  it("detects the scoped-provider error by its Nest exception class name", () => {
    // Nest's real InvalidClassScopeException leaves `.name` as "Error"; the
    // distinguishing signal is the constructor name, not the message.
    class InvalidClassScopeException extends Error {}
    const moduleRef = {
      get: vi.fn(() => {
        throw new InvalidClassScopeException("unhelpful generic text");
      }),
    } as unknown as ModuleRef;
    class ScopedCommand {}
    const registry = new NestCommandRegistry(moduleRef, [
      { name: "scoped", useClass: ScopedCommand as Type<WorkflowCommand> },
    ]);
    expect(() => registry.get("scoped")).toThrow(/singleton-scoped/);
  });

  it("does not blame singleton scope for unrelated resolution failures", () => {
    const cause = new Error("Nest can't resolve dependencies of the StubCommandA (circular dependency).");
    const moduleRef = {
      get: vi.fn(() => {
        throw cause;
      }),
    } as unknown as ModuleRef;
    const registry = new NestCommandRegistry(moduleRef, [{ name: "cmdA", useClass: StubCommandA }]);

    let thrown: unknown;
    try {
      registry.get("cmdA");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkflowError);
    expect((thrown as Error).message).toMatch(/could not be resolved from the NestJS container/);
    expect((thrown as Error).message).not.toMatch(/singleton-scoped/);
    // The original container error is preserved as the cause for diagnosis.
    expect((thrown as WorkflowError).cause).toBe(cause);
  });
});
