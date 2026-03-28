import { Inject, Injectable } from "@nestjs/common";
import type {
  WorkflowRuntime,
  CreateWorkflowInstanceInput,
  TriggerWorkflowEventInput,
  GetAvailableEventsInput,
  WorkflowInstance,
  WorkflowExecutionResult,
  AvailableWorkflowEvent,
  WorkflowInstanceStore,
  WorkflowHistoryStore,
  WorkflowHistoryRecord,
} from "@camcima/duraflows-core";
import {
  WORKFLOW_RUNTIME,
  WORKFLOW_INSTANCE_STORE,
  WORKFLOW_HISTORY_STORE,
} from "../providers/injection-tokens.js";

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_RUNTIME)
    private readonly runtime: WorkflowRuntime,
    @Inject(WORKFLOW_INSTANCE_STORE)
    private readonly instanceStore: WorkflowInstanceStore,
    @Inject(WORKFLOW_HISTORY_STORE)
    private readonly historyStore: WorkflowHistoryStore,
  ) {}

  async createInstance(
    input: CreateWorkflowInstanceInput,
  ): Promise<WorkflowInstance> {
    return this.runtime.createInstance(input);
  }

  async triggerEvent(
    input: TriggerWorkflowEventInput,
  ): Promise<WorkflowExecutionResult> {
    return this.runtime.triggerEvent(input);
  }

  async getAvailableEvents(
    input: GetAvailableEventsInput,
  ): Promise<AvailableWorkflowEvent[]> {
    return this.runtime.getAvailableEvents(input);
  }

  async getInstance(uuid: string): Promise<WorkflowInstance | null> {
    return this.instanceStore.findByUuid(uuid);
  }

  async getHistory(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]> {
    return this.historyStore.findByInstanceUuid(
      workflowInstanceUuid,
      options,
    );
  }
}
