import { Inject, Injectable } from "@nestjs/common";
import type {
  FindParkedTimeoutsInput,
  ProcessExpiredWorkflowsResult,
  WorkflowInstance,
  WorkflowRuntime,
} from "@duraflows/core";
import { WORKFLOW_RUNTIME } from "../providers/injection-tokens.js";

@Injectable()
export class WorkflowTimeoutService {
  constructor(
    @Inject(WORKFLOW_RUNTIME)
    private readonly runtime: WorkflowRuntime,
  ) {}

  async processExpiredWorkflows(limit?: number): Promise<ProcessExpiredWorkflowsResult> {
    return this.runtime.processExpiredWorkflows({ limit });
  }

  /** Instances parked after repeated timeout failures, oldest-parked first. */
  async findParkedTimeouts(input?: FindParkedTimeoutsInput): Promise<WorkflowInstance[]> {
    return this.runtime.findParkedTimeouts(input);
  }

  /** Clears an instance's timeout retry state so the next sweep retries it. */
  async rearmTimeout(workflowInstanceUuid: string): Promise<WorkflowInstance> {
    return this.runtime.rearmTimeout(workflowInstanceUuid);
  }
}
