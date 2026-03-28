import type { CommandResult } from "../types/runtime.js";

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
