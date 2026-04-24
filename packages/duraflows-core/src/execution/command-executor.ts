import type { CommandResult, WorkflowCommand, WorkflowExecutionContext } from "../types/runtime.js";
import type { WorkflowCommandRef } from "../types/definition.js";
import type { WorkflowCommandRegistry } from "../registry/command-registry.js";

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
      let result: CommandResult;

      try {
        result = await command.execute(subject, context);
      } catch (error: unknown) {
        if (command.bestEffort) {
          result = {
            ok: false,
            code: "BEST_EFFORT_THROWN",
            message: error instanceof Error ? error.message : String(error),
            error,
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
