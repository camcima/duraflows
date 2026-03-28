import { describe, it, expect } from "vitest";
import { EventExecutor } from "../../src/execution/event-executor.js";
import { CommandExecutor } from "../../src/execution/command-executor.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { InvalidEventError, CommandFailureError } from "../../src/errors/index.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowCommand, WorkflowExecutionContext, CommandResult } from "../../src/types/runtime.js";
import type { WorkflowCommandRegistry } from "../../src/registry/command-registry.js";

function makeContext(overrides: Partial<WorkflowExecutionContext> = {}): WorkflowExecutionContext {
  return {
    trigger: { type: "system" },
    now: new Date(),
    context: {},
    metadata: {},
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

const compiler = new WorkflowCompiler();

describe("EventExecutor", () => {
  it("should transition to targetState when all commands succeed", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              targetState: "submitted",
              commands: [{ name: "validate" }],
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const registry = makeRegistry({
      validate: successCommand(),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new EventExecutor(commandExecutor);

    const result = await executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext());

    expect(result.outcome).toBe("success");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("submitted");
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].ok).toBe(true);
  });

  it("should transition to errorState when a command fails and errorState is defined", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf-error",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              targetState: "submitted",
              errorState: "failed",
              commands: [{ name: "validate" }],
            },
          },
        },
        submitted: {},
        failed: {},
      },
    };

    const compiled = compiler.compile(definition);
    const registry = makeRegistry({
      validate: failureCommand(),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new EventExecutor(commandExecutor);

    const result = await executor.execute(compiled, "draft", "submit", "instance-2", {}, makeContext());

    expect(result.outcome).toBe("failure");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("failed");
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].ok).toBe(false);
  });

  it("should succeed when any trigger type targets any event", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf-system",
      initialState: "draft",
      states: {
        draft: {
          events: {
            autoProcess: {
              targetState: "processed",
              commands: [{ name: "process" }],
            },
          },
        },
        processed: {},
      },
    };

    const compiled = compiler.compile(definition);
    const registry = makeRegistry({
      process: successCommand(),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new EventExecutor(commandExecutor);

    const result = await executor.execute(
      compiled,
      "draft",
      "autoProcess",
      "instance-5",
      {},
      makeContext({ trigger: { type: "system" } }),
    );

    expect(result.outcome).toBe("success");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("processed");
  });

  it("should throw InvalidEventError when event does not exist on state", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf-invalid",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const registry = makeRegistry({});
    const commandExecutor = new CommandExecutor(registry);
    const executor = new EventExecutor(commandExecutor);

    await expect(
      executor.execute(compiled, "draft", "nonExistentEvent", "instance-6", {}, makeContext()),
    ).rejects.toThrow(InvalidEventError);
  });

  it("should throw CommandFailureError when command fails and no errorState is defined", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf-cmd-fail",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              targetState: "submitted",
              // no errorState
              commands: [{ name: "validate" }],
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const registry = makeRegistry({
      validate: failureCommand({ code: "VALIDATION_ERROR" }),
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new EventExecutor(commandExecutor);

    await expect(executor.execute(compiled, "draft", "submit", "instance-7", {}, makeContext())).rejects.toThrow(
      CommandFailureError,
    );
  });

  it("should succeed with no commands and transition to targetState", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf-no-cmds",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              targetState: "submitted",
              // no commands
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const registry = makeRegistry({});
    const commandExecutor = new CommandExecutor(registry);
    const executor = new EventExecutor(commandExecutor);

    const result = await executor.execute(compiled, "draft", "submit", "instance-8", {}, makeContext());

    expect(result.outcome).toBe("success");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("submitted");
    expect(result.commandResults).toHaveLength(0);
  });

  it("should make context mutations from commands available in the execution context", async () => {
    const definition: WorkflowDefinition = {
      name: "test-wf-ctx",
      initialState: "draft",
      states: {
        draft: {
          events: {
            enrich: {
              targetState: "enriched",
              commands: [{ name: "setFlag" }, { name: "readFlag" }],
            },
          },
        },
        enriched: {},
      },
    };

    let capturedValue: unknown = undefined;

    const setFlagCommand: WorkflowCommand = {
      execute: async (_subject, ctx) => {
        ctx.context["enriched"] = true;
        return { ok: true };
      },
    };

    const readFlagCommand: WorkflowCommand = {
      execute: async (_subject, ctx) => {
        capturedValue = ctx.context["enriched"];
        return { ok: true };
      },
    };

    const compiled = compiler.compile(definition);
    const registry = makeRegistry({
      setFlag: setFlagCommand,
      readFlag: readFlagCommand,
    });
    const commandExecutor = new CommandExecutor(registry);
    const executor = new EventExecutor(commandExecutor);

    const ctx = makeContext();
    const result = await executor.execute(compiled, "draft", "enrich", "instance-9", {}, ctx);

    expect(result.outcome).toBe("success");
    expect(capturedValue).toBe(true);
    expect(ctx.context["enriched"]).toBe(true);
  });
});
