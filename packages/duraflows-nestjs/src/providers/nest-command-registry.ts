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
    try {
      return this.moduleRef.get(cls, { strict: false });
    } catch (error) {
      // `ModuleRef.get()` fails for many reasons — a missing provider, a
      // circular dependency, a throwing constructor — not only unsupported
      // scopes. Wrap every failure with a generic resolution message and only
      // add the singleton-scope hint when the underlying error is Nest's
      // scoped-provider rejection, so the guidance is never misleading. The
      // original error is attached as the cause either way.
      let message = `Command "${name}" could not be resolved from the NestJS container.`;
      if (isScopedProviderError(error)) {
        message +=
          ` Workflow command providers must be singleton-scoped (the default); ` +
          `REQUEST- and TRANSIENT-scoped providers are not supported.`;
      }
      throw new WorkflowError(message, error);
    }
  }

  has(name: string): boolean {
    return this.registrations.has(name);
  }

  getRegisteredNames(): Set<string> {
    return new Set(this.registrations.keys());
  }
}

/**
 * Nest throws `InvalidClassScopeException` (message: "... is marked as a scoped
 * provider ...") when `get()` is called on a REQUEST/TRANSIENT provider. That
 * class is not part of Nest's public API, so match on the constructor name with
 * a message-content fallback to survive version drift.
 */
function isScopedProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.constructor.name === "InvalidClassScopeException" || /scoped provider/i.test(error.message);
}
