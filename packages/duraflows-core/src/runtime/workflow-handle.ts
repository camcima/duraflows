import type {
  WorkflowInstance,
  WorkflowExecutionResult,
  AvailableWorkflowEvent,
  TriggerWorkflowEventInput,
  GetAvailableEventsInput,
} from "../types/runtime.js";
import type { WorkflowHistoryRecord } from "../types/persistence.js";

export interface WorkflowRuntimeClient {
  getInstance(uuid: string): Promise<WorkflowInstance | null>;
  triggerEvent(input: TriggerWorkflowEventInput): Promise<WorkflowExecutionResult>;
  getAvailableEvents(input: GetAvailableEventsInput): Promise<AvailableWorkflowEvent[]>;
  getHistory(
    workflowInstanceUuid: string,
    options?: { limit?: number; offset?: number },
  ): Promise<WorkflowHistoryRecord[]>;
}

export class WorkflowHandle {
  readonly uuid: string;
  private readonly client: WorkflowRuntimeClient;

  constructor(uuid: string, client: WorkflowRuntimeClient) {
    this.uuid = uuid;
    this.client = client;
  }

  async getInstance(): Promise<WorkflowInstance | null> {
    return this.client.getInstance(this.uuid);
  }

  async triggerEvent(
    eventName: string,
    options?: { subject?: unknown; triggerMetadata?: Record<string, unknown> },
  ): Promise<WorkflowExecutionResult> {
    return this.client.triggerEvent({
      workflowInstanceUuid: this.uuid,
      eventName,
      subject: options?.subject,
      triggerMetadata: options?.triggerMetadata,
    });
  }

  async getAvailableEvents(): Promise<AvailableWorkflowEvent[]> {
    return this.client.getAvailableEvents({
      workflowInstanceUuid: this.uuid,
    });
  }

  async getHistory(options?: { limit?: number; offset?: number }): Promise<WorkflowHistoryRecord[]> {
    return this.client.getHistory(this.uuid, options);
  }
}
