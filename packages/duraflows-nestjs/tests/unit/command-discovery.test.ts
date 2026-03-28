import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { mergeCommandRegistrations } from "../../src/providers/command-discovery.js";
import { WorkflowError } from "@camcima/duraflows-core";

class CommandA {
  async execute() {
    return { ok: true };
  }
}

class CommandB {
  async execute() {
    return { ok: true };
  }
}

class CommandC {
  async execute() {
    return { ok: true };
  }
}

describe("mergeCommandRegistrations", () => {
  it("merges explicit and discovered with no overlap", () => {
    const explicit = [{ name: "cmdA", useClass: CommandA }];
    const discovered = [{ name: "cmdB", useClass: CommandB }];

    const merged = mergeCommandRegistrations(explicit, discovered);

    expect(merged).toHaveLength(2);
    expect(merged[0].name).toBe("cmdA");
    expect(merged[1].name).toBe("cmdB");
  });

  it("returns explicit only when discovered is empty", () => {
    const explicit = [{ name: "cmdA", useClass: CommandA }];
    const merged = mergeCommandRegistrations(explicit, []);
    expect(merged).toEqual(explicit);
  });

  it("returns discovered only when explicit is empty", () => {
    const discovered = [{ name: "cmdB", useClass: CommandB }];
    const merged = mergeCommandRegistrations([], discovered);
    expect(merged).toEqual(discovered);
  });

  it("returns empty when both are empty", () => {
    const merged = mergeCommandRegistrations([], []);
    expect(merged).toEqual([]);
  });

  it("throws WorkflowError on name conflict", () => {
    const explicit = [{ name: "cmd", useClass: CommandA }];
    const discovered = [{ name: "cmd", useClass: CommandB }];

    expect(() => mergeCommandRegistrations(explicit, discovered)).toThrow(WorkflowError);
    expect(() => mergeCommandRegistrations(explicit, discovered)).toThrow(
      "registered both explicitly",
    );
  });

  it("preserves order: explicit first, then discovered", () => {
    const explicit = [{ name: "b", useClass: CommandB }];
    const discovered = [
      { name: "a", useClass: CommandA },
      { name: "c", useClass: CommandC },
    ];

    const merged = mergeCommandRegistrations(explicit, discovered);
    expect(merged.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });
});
