import type { CommandResult, MigrateInstancesResult } from "../types/runtime.js";

/**
 * A thrown value as text: an `Error`'s `message`, otherwise `String(value)`,
 * otherwise its `Object.prototype.toString` tag (e.g. a null-prototype object
 * with no inherited `toString`), otherwise "unknown error". Never throws, so a
 * hostile throw — a throwing `message` getter, `toString` or
 * `Symbol.toPrimitive` — cannot escape from formatting it. Internal: not
 * re-exported from the package.
 */
export function describeThrown(value: unknown): string {
  try {
    if (value instanceof Error) return String(value.message);
    try {
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  } catch {
    return "unknown error";
  }
}

export class WorkflowError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorkflowError";
  }
}

export class WorkflowDefinitionError extends WorkflowError {
  public readonly workflowName: string;

  constructor(workflowName: string, message: string) {
    super(`Workflow "${workflowName}": ${message}`);
    this.name = "WorkflowDefinitionError";
    this.workflowName = workflowName;
  }
}

export class InvalidArgumentError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

export class IdempotencyConflictError extends WorkflowError {
  constructor(public readonly workflowInstanceUuid: string) {
    super(`Idempotency key was reused with a different event or fingerprint for instance "${workflowInstanceUuid}"`);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyInProgressError extends WorkflowError {
  constructor(public readonly workflowInstanceUuid: string) {
    super(`Idempotent event is already executing in this transaction for instance "${workflowInstanceUuid}"`);
    this.name = "IdempotencyInProgressError";
  }
}

export class IdempotencyNotSupportedError extends WorkflowError {
  constructor() {
    super("An idempotency key requires a configured WorkflowIdempotencyStore");
    this.name = "IdempotencyNotSupportedError";
  }
}

export class WorkflowInstanceNotFoundError extends WorkflowError {
  public readonly workflowInstanceUuid: string;

  constructor(workflowInstanceUuid: string) {
    super(`Workflow instance "${workflowInstanceUuid}" not found`);
    this.name = "WorkflowInstanceNotFoundError";
    this.workflowInstanceUuid = workflowInstanceUuid;
  }
}

export class InvalidEventError extends WorkflowError {
  public readonly workflowInstanceUuid: string;
  public readonly currentState: string;
  public readonly eventName: string;

  constructor(workflowInstanceUuid: string, currentState: string, eventName: string) {
    super(`Event "${eventName}" is not available on state "${currentState}" for instance "${workflowInstanceUuid}"`);
    this.name = "InvalidEventError";
    this.workflowInstanceUuid = workflowInstanceUuid;
    this.currentState = currentState;
    this.eventName = eventName;
  }
}

/**
 * Thrown under `versionPolicy: "latest"` when an instance's current state does
 * not exist in the latest registered definition, instead of running the
 * instance on a definition that cannot describe it.
 */
export class IncompatibleDefinitionError extends WorkflowError {
  public readonly workflowInstanceUuid: string;
  public readonly workflowName: string;
  public readonly currentState: string;
  public readonly version: number;

  constructor(workflowInstanceUuid: string, workflowName: string, currentState: string, version: number) {
    super(
      `Instance "${workflowInstanceUuid}" is in state "${currentState}", ` +
        `which version ${version} of workflow "${workflowName}" does not define`,
    );
    this.name = "IncompatibleDefinitionError";
    this.workflowInstanceUuid = workflowInstanceUuid;
    this.workflowName = workflowName;
    this.currentState = currentState;
    this.version = version;
  }
}

export class OnEnterDepthExceededError extends WorkflowError {
  public readonly workflowInstanceUuid: string;
  public readonly stateName: string;
  public readonly depth: number;

  constructor(workflowInstanceUuid: string, stateName: string, depth: number) {
    super(
      `onEnter chain exceeded maximum depth of ${depth} at state "${stateName}" for instance "${workflowInstanceUuid}"`,
    );
    this.name = "OnEnterDepthExceededError";
    this.workflowInstanceUuid = workflowInstanceUuid;
    this.stateName = stateName;
    this.depth = depth;
  }
}

export class CommandFailureError extends WorkflowError {
  public readonly workflowInstanceUuid: string;
  public readonly eventName: string;
  public readonly commandName: string;
  public readonly result: CommandResult;

  constructor(workflowInstanceUuid: string, eventName: string, commandName: string, result: CommandResult) {
    super(
      `Command "${commandName}" failed for event "${eventName}" on instance "${workflowInstanceUuid}": ${result.message ?? result.code ?? "unknown"}`,
    );
    this.name = "CommandFailureError";
    this.workflowInstanceUuid = workflowInstanceUuid;
    this.eventName = eventName;
    this.commandName = commandName;
    this.result = result;
  }
}

/**
 * Thrown by `migrateInstances` when listing candidates fails partway through:
 * the store threw, or returned a page that breaks its contract. `result`
 * holds everything done so far; resume with `result.nextCursor`.
 */
export class MigrationInterruptedError extends WorkflowError {
  public readonly result: MigrateInstancesResult;

  constructor(result: MigrateInstancesResult, examined: number, cause: unknown) {
    super(`migrateInstances was interrupted after examining ${examined} candidates: ${describeThrown(cause)}`, cause);
    this.name = "MigrationInterruptedError";
    this.result = result;
  }
}
