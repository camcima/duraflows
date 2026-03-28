import type { ModuleRef } from "@nestjs/core";
import type { Type } from "@nestjs/common";
import type { WorkflowCommandRegistry, WorkflowCommand } from "@duraflows/core";
import { WorkflowError } from "@duraflows/core";

export interface WorkflowCommandRegistration {
  name: string;
  useClass: Type<WorkflowCommand>;
}

export class NestCommandRegistry implements WorkflowCommandRegistry {
  private readonly registrations = new Map<string, Type<WorkflowCommand>>();

  constructor(
    private readonly moduleRef: ModuleRef,
    registrations: WorkflowCommandRegistration[] = [],
  ) {
    for (const reg of registrations) {
      if (this.registrations.has(reg.name)) {
        throw new WorkflowError(`Command "${reg.name}" is already registered`);
      }
      this.registrations.set(reg.name, reg.useClass);
    }
  }

  get(name: string): WorkflowCommand {
    const cls = this.registrations.get(name);
    if (!cls) {
      throw new WorkflowError(`Command "${name}" not found in registry`);
    }
    return this.moduleRef.get(cls, { strict: false });
  }

  has(name: string): boolean {
    return this.registrations.has(name);
  }

  getRegisteredNames(): Set<string> {
    return new Set(this.registrations.keys());
  }
}
