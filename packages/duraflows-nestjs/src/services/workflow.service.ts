import { Inject, Injectable } from "@nestjs/common";
import { WorkflowHandle } from "@duraflows/core";
import type {
  WorkflowRuntime,
  CreateWorkflowInstanceInput,
  TriggerWorkflowEventInput,
  GetAvailableEventsInput,
  WorkflowInstance,
  WorkflowExecutionResult,
  AvailableWorkflowEvent,
  WorkflowHistoryRecord,
} from "@duraflows/core";
import { WORKFLOW_RUNTIME } from "../providers/injection-tokens.js";

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_RUNTIME)
    private readonly runtime: WorkflowRuntime,
  ) {}

  async createInstance(input: CreateWorkflowInstanceInput): Promise<WorkflowInstance> {
    return this.runtime.createInstance(input);
  }

  async triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult> {
    return this.runtime.triggerEvent(input);
  }

  async getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]> {
    return this.runtime.getAvailableEvents(input);
  }

  async getInstance(uuid: string): Promise<WorkflowInstance | null> {
    return this.runtime.getInstance(uuid);
  }

  async getHistory(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    return this.runtime.getHistory(workflowInstanceUuid, options);
  }

  getHandle(uuid: string): WorkflowHandle {
    return new WorkflowHandle(uuid, this);
  }
}
