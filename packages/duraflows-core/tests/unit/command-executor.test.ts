import { describe, it, expect } from "vitest";
import { CommandExecutor } from "../../src/execution/command-executor.js";
import type { WorkflowCommandRegistry } from "../../src/registry/command-registry.js";
import type { WorkflowCommand, CommandResult, WorkflowExecutionContext } from "../../src/types/runtime.js";
import type { WorkflowCommandRef } from "../../src/types/definition.js";

function createMockRegistry(commands: Record<string, WorkflowCommand>): WorkflowCommandRegistry {
  return {
    get(name: string): WorkflowCommand {
      const command = commands[name];
      if (!command) {
        throw new Error(`Command "${name}" not found in mock registry`);
      }
      return command;
    },
    has(name: string): boolean {
      return name in commands;
    },
  };
}

function createContext(): WorkflowExecutionContext {
  return {
    triggerMetadata: { actor: "actor-1" },
    now: new Date("2026-01-01T00:00:00Z"),
    context: {},
    metadata: {},
    fromState: "fromState-test",
    toState: "toState-test",
    transitionUuid: "00000000-0000-0000-0000-000000000001",
  };
}

function okResult(overrides?: Partial<CommandResult>): CommandResult {
  return { ok: true, ...overrides };
}

function failResult(overrides?: Partial<CommandResult>): CommandResult {
  return { ok: false, ...overrides };
}

describe("CommandExecutor", () => {
  it("returns outcome 'success' with empty commandResults when commands array is empty", async () => {
    const registry = createMockRegistry({});
    const executor = new CommandExecutor(registry);

    const result = await executor.execute([], {}, createContext());

    expect(result).toEqual({ outcome: "success", commandResults: [] });
  });

  it("returns outcome 'success' with all results when all commands succeed", async () => {
    const resultA = okResult({ code: "A_OK" });
    const resultB = okResult({ code: "B_OK" });

    const registry = createMockRegistry({
      cmdA: { execute: () => resultA },
      cmdB: { execute: () => resultB },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "cmdA" }, { name: "cmdB" }];
    const result = await executor.execute(commands, {}, createContext());

    expect(result.outcome).toBe("success");
    expect(result.commandResults).toEqual([resultA, resultB]);
  });

  it("stops execution and returns outcome 'failure' when the first command fails", async () => {
    const failedResult = failResult({ code: "FIRST_FAILED" });
    let secondCalled = false;

    const registry = createMockRegistry({
      cmdFail: { execute: () => failedResult },
      cmdNever: {
        execute: () => {
          secondCalled = true;
          return okResult();
        },
      },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "cmdFail" }, { name: "cmdNever" }];
    const result = await executor.execute(commands, {}, createContext());

    expect(result.outcome).toBe("failure");
    expect(result.commandResults).toEqual([failedResult]);
    expect(secondCalled).toBe(false);
  });

  it("collects first result and stops at second failure (fail-fast), third never called", async () => {
    const firstResult = okResult({ code: "FIRST_OK" });
    const secondResult = failResult({ code: "SECOND_FAILED" });
    let thirdCalled = false;

    const registry = createMockRegistry({
      cmd1: { execute: () => firstResult },
      cmd2: { execute: () => secondResult },
      cmd3: {
        execute: () => {
          thirdCalled = true;
          return okResult();
        },
      },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "cmd1" }, { name: "cmd2" }, { name: "cmd3" }];
    const result = await executor.execute(commands, {}, createContext());

    expect(result.outcome).toBe("failure");
    expect(result.commandResults).toEqual([firstResult, secondResult]);
    expect(thirdCalled).toBe(false);
  });

  it("propagates exception thrown by a command", async () => {
    const error = new Error("command blew up");

    const registry = createMockRegistry({
      cmdBoom: {
        execute: () => {
          throw error;
        },
      },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "cmdBoom" }];

    await expect(executor.execute(commands, {}, createContext())).rejects.toThrow(error);
  });

  it("does not abort when a best-effort command returns ok:false; continues to next command", async () => {
    const beResult = failResult({ code: "BE_FAILED" });
    const okFollowing = okResult({ code: "AFTER_BE" });
    let secondCalled = false;

    const registry = createMockRegistry({
      cmdBE: {
        bestEffort: true,
        execute: () => beResult,
      },
      cmdAfter: {
        execute: () => {
          secondCalled = true;
          return okFollowing;
        },
      },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "cmdBE" }, { name: "cmdAfter" }];
    const result = await executor.execute(commands, {}, createContext());

    expect(result.outcome).toBe("success");
    expect(result.commandResults).toEqual([beResult, okFollowing]);
    expect(secondCalled).toBe(true);
  });

  it("converts a thrown exception from a best-effort command into a CommandResult and continues", async () => {
    const error = new Error("boom");
    const okFollowing = okResult({ code: "AFTER_THROW" });
    let secondCalled = false;

    const registry = createMockRegistry({
      cmdThrowBE: {
        bestEffort: true,
        execute: () => {
          throw error;
        },
      },
      cmdAfter: {
        execute: () => {
          secondCalled = true;
          return okFollowing;
        },
      },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "cmdThrowBE" }, { name: "cmdAfter" }];
    const result = await executor.execute(commands, {}, createContext());

    expect(result.outcome).toBe("success");
    expect(result.commandResults).toHaveLength(2);
    expect(result.commandResults[0].ok).toBe(false);
    expect(result.commandResults[0].code).toBe("BEST_EFFORT_THROWN");
    expect(result.commandResults[0].message).toBe("boom");
    expect(result.commandResults[0].error).toBe(error);
    expect(result.commandResults[1]).toEqual(okFollowing);
    expect(secondCalled).toBe(true);
  });

  it("aborts on mandatory command failure even after a best-effort failure already occurred", async () => {
    const beFail = failResult({ code: "BE_FAIL" });
    const mandatoryFail = failResult({ code: "MANDATORY_FAIL" });
    let thirdCalled = false;

    const registry = createMockRegistry({
      cmdBE: {
        bestEffort: true,
        execute: () => beFail,
      },
      cmdMandatory: {
        execute: () => mandatoryFail,
      },
      cmdNever: {
        execute: () => {
          thirdCalled = true;
          return okResult();
        },
      },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "cmdBE" }, { name: "cmdMandatory" }, { name: "cmdNever" }];
    const result = await executor.execute(commands, {}, createContext());

    expect(result.outcome).toBe("failure");
    expect(result.commandResults).toEqual([beFail, mandatoryFail]);
    expect(thirdCalled).toBe(false);
  });

  it("executes commands in definition order", async () => {
    const callOrder: string[] = [];

    const registry = createMockRegistry({
      first: {
        execute: () => {
          callOrder.push("first");
          return okResult();
        },
      },
      second: {
        execute: () => {
          callOrder.push("second");
          return okResult();
        },
      },
      third: {
        execute: () => {
          callOrder.push("third");
          return okResult();
        },
      },
    });
    const executor = new CommandExecutor(registry);

    const commands: WorkflowCommandRef[] = [{ name: "first" }, { name: "second" }, { name: "third" }];
    await executor.execute(commands, {}, createContext());

    expect(callOrder).toEqual(["first", "second", "third"]);
  });
});
