import { Inject, Injectable } from "@nestjs/common";
import type { WorkflowRuntime, ProcessExpiredWorkflowsResult } from "@duraflows/core";
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
}
