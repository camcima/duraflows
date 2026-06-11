import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NestCommandRegistry } from "../../src/providers/nest-command-registry.js";
import { WorkflowError } from "@duraflows/core";
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
    get: vi.fn().mockImplementation((cls: any) => new cls()),
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
    const registry = new NestCommandRegistry(moduleRef, [{ name: "scoped", useClass: ScopedCommand as any }]);
    expect(() => registry.get("scoped")).toThrow(/singleton-scoped/);
  });
});
