import type { WorkflowCommand } from "../types/runtime.js";
import { WorkflowError } from "../errors/index.js";

export interface WorkflowCommandRegistry {
  get(name: string): WorkflowCommand;
  has(name: string): boolean;
}

export class InMemoryCommandRegistry implements WorkflowCommandRegistry {
  private readonly commands = new Map<string, WorkflowCommand>();

  register(name: string, command: WorkflowCommand): void {
    if (this.commands.has(name)) {
      throw new WorkflowError(
        `Command "${name}" is already registered`,
      );
    }
    this.commands.set(name, command);
  }

  get(name: string): WorkflowCommand {
    const command = this.commands.get(name);
    if (!command) {
      throw new WorkflowError(
        `Command "${name}" not found in registry`,
      );
    }
    return command;
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }
}
