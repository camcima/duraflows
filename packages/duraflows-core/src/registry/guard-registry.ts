import type { WorkflowGuard } from "../types/runtime.js";
import { WorkflowError } from "../errors/index.js";

export interface WorkflowGuardRegistry {
  get(name: string): WorkflowGuard;
  has(name: string): boolean;
}

export class InMemoryGuardRegistry implements WorkflowGuardRegistry {
  private readonly guards = new Map<string, WorkflowGuard>();

  register(name: string, guard: WorkflowGuard): void {
    if (this.guards.has(name)) {
      throw new WorkflowError(`Guard "${name}" is already registered`);
    }
    this.guards.set(name, guard);
  }

  get(name: string): WorkflowGuard {
    const guard = this.guards.get(name);
    if (!guard) {
      throw new WorkflowError(`Guard "${name}" not found in registry`);
    }
    return guard;
  }

  has(name: string): boolean {
    return this.guards.has(name);
  }
}
