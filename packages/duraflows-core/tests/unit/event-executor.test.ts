import { describe, it, expect } from "vitest";
import { EventExecutor } from "../../src/execution/event-executor.js";
import { CommandExecutor } from "../../src/execution/command-executor.js";
import { WorkflowCompiler } from "../../src/compilation/workflow-compiler.js";
import { InvalidEventError, CommandFailureError } from "../../src/errors/index.js";
import type { WorkflowDefinition } from "../../src/types/definition.js";
import type { WorkflowCommand, WorkflowExecutionContext, CommandResult } from "../../src/types/runtime.js";
import type { WorkflowCommandRegistry } from "../../src/registry/command-registry.js";
import type { WorkflowGuard } from "../../src/types/runtime.js";
import type { WorkflowGuardRegistry } from "../../src/registry/guard-registry.js";

function makeGuardRegistry(guards: Record<string, WorkflowGuard>): WorkflowGuardRegistry {
  return {
    get(name) {
      const g = guards[name];
      if (!g) throw new Error(`Guard "${name}" not found`);
      return g;
    },
    has(name) {
      return name in guards;
    },
  };
}

function makeContext(overrides: Partial<WorkflowExecutionContext> = {}): WorkflowExecutionContext {
  return {
    triggerMetadata: {},
    now: new Date(),
    context: {},
    metadata: {},
    commandMetadata: Object.freeze({}),
    fromState: "test-from",
    toState: "test-to",
    transitionUuid: "00000000-0000-0000-0000-000000000002",
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

  it("runs commands when guard returns true", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
              commands: [{ name: "validate" }],
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const cmdRegistry = makeRegistry({ validate: successCommand() });
    const guardRegistry = makeGuardRegistry({
      isVerified: { name: "isVerified", evaluate: () => true },
    });
    const executor = new EventExecutor(new CommandExecutor(cmdRegistry), guardRegistry);

    const result = await executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext());

    expect(result.outcome).toBe("success");
    expect(result.toState).toBe("submitted");
    expect(result.commandResults).toHaveLength(1);
    expect(result.rejectedBy).toBeUndefined();
  });

  it("short-circuits with guard-rejected when guard returns false", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
              commands: [{ name: "validate" }],
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    let validateCalls = 0;
    const cmdRegistry = makeRegistry({
      validate: {
        execute: async () => {
          validateCalls++;
          return { ok: true };
        },
      },
    });
    const guardRegistry = makeGuardRegistry({
      isVerified: { name: "isVerified", evaluate: () => false },
    });
    const executor = new EventExecutor(new CommandExecutor(cmdRegistry), guardRegistry);

    const result = await executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext());

    expect(result.outcome).toBe("guard-rejected");
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("draft");
    expect(result.commandResults).toEqual([]);
    expect(result.rejectedBy).toBe("isVerified");
    expect(validateCalls).toBe(0);
  });

  it("supports async guards", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const guardRegistry = makeGuardRegistry({
      isVerified: { name: "isVerified", evaluate: async () => false },
    });
    const executor = new EventExecutor(new CommandExecutor(makeRegistry({})), guardRegistry);

    const result = await executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext());

    expect(result.outcome).toBe("guard-rejected");
    expect(result.rejectedBy).toBe("isVerified");
  });

  it("propagates errors thrown by the guard", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "boom" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const guardRegistry = makeGuardRegistry({
      boom: {
        name: "boom",
        evaluate: () => {
          throw new Error("guard exploded");
        },
      },
    });
    const executor = new EventExecutor(new CommandExecutor(makeRegistry({})), guardRegistry);

    await expect(executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext())).rejects.toThrow(
      "guard exploded",
    );
  });

  it("exposes guard ref metadata via commandMetadata during evaluate", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "hasRole", metadata: { requiredRole: "manager" } },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    let observed: unknown;
    const guardRegistry = makeGuardRegistry({
      hasRole: {
        name: "hasRole",
        evaluate: (_subject, ctx) => {
          observed = ctx.commandMetadata;
          return true;
        },
      },
    });
    const executor = new EventExecutor(new CommandExecutor(makeRegistry({})), guardRegistry);

    await executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext());

    expect(observed).toEqual({ requiredRole: "manager" });
  });

  it("passes triggerMetadata and instance context through to the guard", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "checkBoth" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    let seenTrigger: unknown;
    let seenContext: unknown;
    const guardRegistry = makeGuardRegistry({
      checkBoth: {
        name: "checkBoth",
        evaluate: (_subject, ctx) => {
          seenTrigger = ctx.triggerMetadata;
          seenContext = ctx.context;
          return true;
        },
      },
    });
    const executor = new EventExecutor(new CommandExecutor(makeRegistry({})), guardRegistry);

    await executor.execute(
      compiled,
      "draft",
      "submit",
      "instance-1",
      {},
      makeContext({
        triggerMetadata: { actor: "user-42" },
        context: { submitterVerified: true },
      }),
    );

    expect(seenTrigger).toEqual({ actor: "user-42" });
    expect(seenContext).toEqual({ submitterVerified: true });
  });

  it("passes the subject through to the guard", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "subjectAware" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    let seenSubject: unknown;
    const guardRegistry = makeGuardRegistry({
      subjectAware: {
        name: "subjectAware",
        evaluate: (subject) => {
          seenSubject = subject;
          return true;
        },
      },
    });
    const executor = new EventExecutor(new CommandExecutor(makeRegistry({})), guardRegistry);
    const subject = { orderId: "abc-123" };

    await executor.execute(compiled, "draft", "submit", "instance-1", subject, makeContext());

    expect(seenSubject).toBe(subject);
  });

  it("returns guard-rejected (not failure routed to errorState) when guard rejects on an event with errorState", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
              errorState: "submitFailed",
              commands: [{ name: "validate" }],
            },
          },
        },
        submitted: {},
        submitFailed: {},
      },
    };

    const compiled = compiler.compile(definition);
    const cmdRegistry = makeRegistry({ validate: successCommand() });
    const guardRegistry = makeGuardRegistry({
      isVerified: { name: "isVerified", evaluate: () => false },
    });
    const executor = new EventExecutor(new CommandExecutor(cmdRegistry), guardRegistry);

    const result = await executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext());

    expect(result.outcome).toBe("guard-rejected");
    expect(result.toState).toBe("draft"); // not "submitFailed"
    expect(result.commandResults).toEqual([]);
    expect(result.rejectedBy).toBe("isVerified");
  });

  it("rejects a command-only event with no targetState/errorState when guard returns false", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "active",
      states: {
        active: {
          events: {
            ping: {
              guard: { name: "isAllowed" },
              commands: [{ name: "log" }],
            },
          },
        },
      },
    };

    const compiled = compiler.compile(definition);
    let logCalls = 0;
    const cmdRegistry = makeRegistry({
      log: {
        execute: async () => {
          logCalls++;
          return { ok: true };
        },
      },
    });
    const guardRegistry = makeGuardRegistry({
      isAllowed: { name: "isAllowed", evaluate: () => false },
    });
    const executor = new EventExecutor(new CommandExecutor(cmdRegistry), guardRegistry);

    const result = await executor.execute(compiled, "active", "ping", "instance-1", {}, makeContext());

    expect(result.outcome).toBe("guard-rejected");
    expect(result.toState).toBe("active");
    expect(logCalls).toBe(0);
  });

  it("throws when an event declares a guard but no guard registry is configured", async () => {
    const definition: WorkflowDefinition = {
      name: "guarded-wf",
      initialState: "draft",
      states: {
        draft: {
          events: {
            submit: {
              guard: { name: "isVerified" },
              targetState: "submitted",
            },
          },
        },
        submitted: {},
      },
    };

    const compiled = compiler.compile(definition);
    const executor = new EventExecutor(new CommandExecutor(makeRegistry({})));

    await expect(executor.execute(compiled, "draft", "submit", "instance-1", {}, makeContext())).rejects.toThrow(
      /guard "isVerified" but no guard registry/,
    );
  });
});
