import type { CommandResult, WorkflowCommand, WorkflowExecutionContext } from "../types/runtime.js";
import type { WorkflowCommandRef } from "../types/definition.js";
import type { WorkflowCommandRegistry } from "../registry/command-registry.js";

function toSerializableError(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return { name: "UnknownError", message: String(value) };
}

function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return obj;
}

export interface CommandExecutionResult {
  outcome: "success" | "failure";
  commandResults: CommandResult[];
}

export class CommandExecutor {
  constructor(private readonly commandRegistry: WorkflowCommandRegistry) {}

  async execute(
    commands: WorkflowCommandRef[],
    subject: unknown,
    context: WorkflowExecutionContext,
  ): Promise<CommandExecutionResult> {
    if (commands.length === 0) {
      return { outcome: "success", commandResults: [] };
    }

    const commandResults: CommandResult[] = [];

    for (const commandRef of commands) {
      const command: WorkflowCommand = this.commandRegistry.get(commandRef.name);
      const commandContext: WorkflowExecutionContext = {
        ...context,
        commandMetadata: deepFreeze(structuredClone(commandRef.metadata ?? {})),
      };
      let result: CommandResult;

      try {
        result = await command.execute(subject, commandContext);
      } catch (error: unknown) {
        if (command.bestEffort) {
          const message = error instanceof Error ? error.message : String(error);
          result = {
            ok: false,
            code: "BEST_EFFORT_THROWN",
            message,
            error: toSerializableError(error),
          };
        } else {
          throw error;
        }
      }

      commandResults.push(result);

      if (!result.ok && !command.bestEffort) {
        return { outcome: "failure", commandResults };
      }
    }

    return { outcome: "success", commandResults };
  }
}
