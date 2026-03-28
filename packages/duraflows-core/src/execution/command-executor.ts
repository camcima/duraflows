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
      const result = await command.execute(subject, context);
      commandResults.push(result);

      if (!result.ok) {
        return { outcome: "failure", commandResults };
      }
    }

    return { outcome: "success", commandResults };
  }
}
