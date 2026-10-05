import type { EnqueueWorkflowEventInput, DurableWorkflowExecution } from "../types/durable.js";
import { DurableExecutionNotSupportedError } from "../errors/index.js";
import type {
  WorkflowInstance,
  WorkflowExecutionResult,
  AvailableWorkflowEvent,
  TriggerWorkflowEventInput,
  GetAvailableEventsInput,
} from "../types/runtime.js";
import type { WorkflowHistoryRecord } from "../types/persistence.js";

export interface WorkflowRuntimeClient {
  enqueueEvent?(input: EnqueueWorkflowEventInput): Promise<DurableWorkflowExecution>;
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
    options?: Omit<TriggerWorkflowEventInput, "workflowInstanceUuid" | "eventName">,
  ): Promise<WorkflowExecutionResult> {
    return this.client.triggerEvent({
      workflowInstanceUuid: this.uuid,
      eventName,
      subject: options?.subject,
      triggerMetadata: options?.triggerMetadata,
      idempotencyKey: options?.idempotencyKey,
      idempotencyFingerprint: options?.idempotencyFingerprint,
    });
  }

  async enqueueEvent(
    eventName: string,
    options: Omit<EnqueueWorkflowEventInput, "workflowInstanceUuid" | "eventName">,
  ): Promise<DurableWorkflowExecution> {
    if (!this.client.enqueueEvent) throw new DurableExecutionNotSupportedError();
    return this.client.enqueueEvent({ ...options, workflowInstanceUuid: this.uuid, eventName });
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
