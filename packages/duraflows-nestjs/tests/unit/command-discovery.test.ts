import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { discoverDecoratedCommands, mergeCommandRegistrations } from "../../src/providers/command-discovery.js";
import { WORKFLOW_COMMAND_METADATA_KEY } from "../../src/decorators/workflow-command.decorator.js";
import { WorkflowError } from "@duraflows/core";

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

// ---------------------------------------------------------------------------
// discoverDecoratedCommands
// ---------------------------------------------------------------------------

function createMockDiscoveryService(providers: Array<{ metadata: unknown; metatype: unknown }>) {
  return {
    getProviders: () => providers.map((p) => ({ metatype: p.metatype })),
    getMetadataByDecorator: (_decorator: unknown, wrapper: any) => {
      const match = providers.find((p) => p.metatype === wrapper.metatype);
      return match?.metadata;
    },
  };
}

describe("discoverDecoratedCommands", () => {
  it("returns registrations for providers with string metadata", () => {
    const result = discoverDecoratedCommands(
      createMockDiscoveryService([
        { metadata: "cmd-a", metatype: CommandA },
        { metadata: "cmd-b", metatype: CommandB },
      ]) as any,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "cmd-a", useClass: CommandA });
    expect(result[1]).toEqual({ name: "cmd-b", useClass: CommandB });
  });

  it("handles array metadata by extracting first element", () => {
    const result = discoverDecoratedCommands(
      createMockDiscoveryService([{ metadata: ["array-cmd"], metatype: CommandA }]) as any,
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("array-cmd");
  });

  it("skips providers with non-string metadata", () => {
    const result = discoverDecoratedCommands(
      createMockDiscoveryService([
        { metadata: undefined, metatype: CommandA },
        { metadata: 42, metatype: CommandB },
      ]) as any,
    );

    expect(result).toHaveLength(0);
  });

  it("skips providers with null metatype", () => {
    const result = discoverDecoratedCommands(
      createMockDiscoveryService([{ metadata: "cmd-a", metatype: null }]) as any,
    );

    expect(result).toHaveLength(0);
  });

  it("returns empty array when no providers match", () => {
    const result = discoverDecoratedCommands(createMockDiscoveryService([]) as any);

    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mergeCommandRegistrations
// ---------------------------------------------------------------------------

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
    expect(() => mergeCommandRegistrations(explicit, discovered)).toThrow("registered both explicitly");
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
