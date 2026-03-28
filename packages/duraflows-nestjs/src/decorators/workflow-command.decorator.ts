import { Injectable } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";

const WorkflowCommandDecorator = DiscoveryService.createDecorator<string>();

export const WORKFLOW_COMMAND_METADATA_KEY = WorkflowCommandDecorator.KEY;

export function WorkflowCommand(name: string): ClassDecorator {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  return (target: Function) => {
    Injectable()(target);
    WorkflowCommandDecorator(name)(target);
  };
}

// Internal: used by discovery helper to extract metadata
export { WorkflowCommandDecorator as InternalWorkflowCommandDecorator };
