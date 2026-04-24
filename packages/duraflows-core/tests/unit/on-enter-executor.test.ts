import { describe, it, expect } from "vitest";
import { OnEnterExecutor } from "../../src/execution/on-enter-executor.js";
import { CommandExecutor } from "../../src/execution/command-executor.js";
import { CommandFailureError, OnEnterDepthExceededError } from "../../src/errors/index.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowCommand, WorkflowExecutionContext, CommandResult } from "../../src/types/runtime.js";
import type { WorkflowCommandRegistry } from "../../src/registry/command-registry.js";

function makeContext(overrides: Partial<WorkflowExecutionContext> = {}): WorkflowExecutionContext {
  return {
    triggerMetadata: {},
    now: new Date(),
    context: {},
    metadata: {},
    fromState: "test-from",
    toState: "test-to",
    transitionUuid: "00000000-0000-0000-0000-000000000003",
    ...overrides,
  };
}

function makeRegistry(commands: Record<string, WorkflowCommand>): WorkflowCommandRegistry {
  return {
    get(name: string): WorkflowCommand {
      const cmd = commands[name];
      if (!cmd) {
        throw new Error(`Command "${name}" not found`);
      }
      return cmd;
    },
    has(name: string): boolean {
      return name in commands;
    },
  };
}

function successCommand(resultOverrides: Partial<CommandResult> = {}): WorkflowCommand {
  return {
    execute: async () => ({ ok: true, ...resultOverrides }),
  };
}

function failureCommand(resultOverrides: Partial<CommandResult> = {}): WorkflowCommand {
  return {
    execute: async () => ({
      ok: false,
      code: "FAIL",
      message: "command failed",
      ...resultOverrides,
    }),
  };
}

describe("OnEnterExecutor", () => {
  it("returns empty hops when state has no onEnter", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "draft",
      states: {
        draft: {},
        submitted: {},
      },
    };

    const registry = makeRegistry({});
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const result = await executor.executeChain(definition, "draft", "instance-1", undefined, makeContext(), 10);

    expect(result.finalState).toBe("draft");
    expect(result.hops).toHaveLength(0);
  });

  it("runs onEnter commands without targetState — stays in current state", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "processing",
      states: {
        processing: {
          onEnter: {
            commands: [{ name: "logEntry" }],
          },
        },
      },
    };

    const registry = makeRegistry({
      logEntry: successCommand({ code: "LOGGED" }),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const result = await executor.executeChain(definition, "processing", "instance-2", undefined, makeContext(), 10);

    expect(result.finalState).toBe("processing");
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0].fromState).toBe("processing");
    expect(result.hops[0].toState).toBe("processing");
    expect(result.hops[0].outcome).toBe("success");
    expect(result.hops[0].commandResults).toHaveLength(1);
    expect(result.hops[0].commandResults[0].ok).toBe(true);
  });

  it("transitions to targetState on success", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "draft",
      states: {
        draft: {
          onEnter: {
            targetState: "active",
            commands: [{ name: "activate" }],
          },
        },
        active: {},
      },
    };

    const registry = makeRegistry({
      activate: successCommand(),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const result = await executor.executeChain(definition, "draft", "instance-3", undefined, makeContext(), 10);

    expect(result.finalState).toBe("active");
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0].fromState).toBe("draft");
    expect(result.hops[0].toState).toBe("active");
    expect(result.hops[0].outcome).toBe("success");
  });

  it("transitions to errorState on command failure", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "processing",
      states: {
        processing: {
          onEnter: {
            targetState: "done",
            errorState: "failed",
            commands: [{ name: "process" }],
          },
        },
        done: {},
        failed: {},
      },
    };

    const registry = makeRegistry({
      process: failureCommand(),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const result = await executor.executeChain(definition, "processing", "instance-4", undefined, makeContext(), 10);

    expect(result.finalState).toBe("failed");
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0].fromState).toBe("processing");
    expect(result.hops[0].toState).toBe("failed");
    expect(result.hops[0].outcome).toBe("failure");
  });

  it("throws CommandFailureError when command fails and no errorState defined", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "processing",
      states: {
        processing: {
          onEnter: {
            targetState: "done",
            commands: [{ name: "process" }],
          },
        },
        done: {},
      },
    };

    const registry = makeRegistry({
      process: failureCommand({ code: "PROCESS_ERROR" }),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    await expect(
      executor.executeChain(definition, "processing", "instance-5", undefined, makeContext(), 10),
    ).rejects.toThrow(CommandFailureError);
  });

  it("chains through multiple onEnter hops (A -> B -> C)", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "stateA",
      states: {
        stateA: {
          onEnter: {
            targetState: "stateB",
            commands: [{ name: "cmdA" }],
          },
        },
        stateB: {
          onEnter: {
            targetState: "stateC",
            commands: [{ name: "cmdB" }],
          },
        },
        stateC: {},
      },
    };

    const registry = makeRegistry({
      cmdA: successCommand({ code: "A_OK" }),
      cmdB: successCommand({ code: "B_OK" }),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const result = await executor.executeChain(definition, "stateA", "instance-6", undefined, makeContext(), 10);

    expect(result.finalState).toBe("stateC");
    expect(result.hops).toHaveLength(2);

    expect(result.hops[0].fromState).toBe("stateA");
    expect(result.hops[0].toState).toBe("stateB");
    expect(result.hops[0].outcome).toBe("success");

    expect(result.hops[1].fromState).toBe("stateB");
    expect(result.hops[1].toState).toBe("stateC");
    expect(result.hops[1].outcome).toBe("success");
  });

  it("accumulates context mutations across hops", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "step1",
      states: {
        step1: {
          onEnter: {
            targetState: "step2",
            commands: [{ name: "setA" }],
          },
        },
        step2: {
          onEnter: {
            targetState: "step3",
            commands: [{ name: "readASetB" }],
          },
        },
        step3: {},
      },
    };

    let capturedA: unknown;

    const setACommand: WorkflowCommand = {
      execute: async (_subject, ctx) => {
        ctx.context["a"] = "fromStep1";
        return { ok: true };
      },
    };

    const readASetBCommand: WorkflowCommand = {
      execute: async (_subject, ctx) => {
        capturedA = ctx.context["a"];
        ctx.context["b"] = "fromStep2";
        return { ok: true };
      },
    };

    const registry = makeRegistry({
      setA: setACommand,
      readASetB: readASetBCommand,
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const ctx = makeContext();
    const result = await executor.executeChain(definition, "step1", "instance-7", undefined, ctx, 10);

    expect(result.finalState).toBe("step3");
    expect(capturedA).toBe("fromStep1");
    expect(ctx.context["a"]).toBe("fromStep1");
    expect(ctx.context["b"]).toBe("fromStep2");
  });

  it("throws OnEnterDepthExceededError when max depth is exceeded", async () => {
    // Create a chain that's 3 hops long, but set maxDepth to 2
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "s1",
      states: {
        s1: {
          onEnter: { targetState: "s2" },
        },
        s2: {
          onEnter: { targetState: "s3" },
        },
        s3: {
          onEnter: { targetState: "s4" },
        },
        s4: {},
      },
    };

    const registry = makeRegistry({});
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    await expect(
      executor.executeChain(
        definition,
        "s1",
        "instance-8",
        undefined,
        makeContext(),
        2, // maxDepth of 2 — third hop should fail
      ),
    ).rejects.toThrow(OnEnterDepthExceededError);
  });

  it("chains through error path (fail -> errorState which has its own onEnter)", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "processing",
      states: {
        processing: {
          onEnter: {
            targetState: "done",
            errorState: "retrying",
            commands: [{ name: "process" }],
          },
        },
        done: {},
        retrying: {
          onEnter: {
            targetState: "escalated",
          },
        },
        escalated: {},
      },
    };

    const registry = makeRegistry({
      process: failureCommand(),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const result = await executor.executeChain(definition, "processing", "instance-9", undefined, makeContext(), 10);

    expect(result.finalState).toBe("escalated");
    expect(result.hops).toHaveLength(2);

    // First hop: processing -> retrying (failure)
    expect(result.hops[0].fromState).toBe("processing");
    expect(result.hops[0].toState).toBe("retrying");
    expect(result.hops[0].outcome).toBe("failure");

    // Second hop: retrying -> escalated (success, no commands)
    expect(result.hops[1].fromState).toBe("retrying");
    expect(result.hops[1].toState).toBe("escalated");
    expect(result.hops[1].outcome).toBe("success");
  });

  it("transitions to targetState with no commands", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "gateway",
      states: {
        gateway: {
          onEnter: {
            targetState: "destination",
          },
        },
        destination: {},
      },
    };

    const registry = makeRegistry({});
    const commandExecutor = new CommandExecutor(registry);
    const executor = new OnEnterExecutor(commandExecutor);

    const result = await executor.executeChain(definition, "gateway", "instance-10", undefined, makeContext(), 10);

    expect(result.finalState).toBe("destination");
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0].fromState).toBe("gateway");
    expect(result.hops[0].toState).toBe("destination");
    expect(result.hops[0].outcome).toBe("success");
    expect(result.hops[0].commandResults).toHaveLength(0);
  });
});
