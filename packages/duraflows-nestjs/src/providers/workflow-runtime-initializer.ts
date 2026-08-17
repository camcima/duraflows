import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { WorkflowRuntime } from "@duraflows/core";
import { WORKFLOW_RUNTIME } from "./injection-tokens.js";

/**
 * Runs `WorkflowRuntime.initialize()` during module init so definition
 * snapshots sync (and version-bump violations surface) at application
 * startup rather than on the first workflow operation.
 */
@Injectable()
export class WorkflowRuntimeInitializer implements OnModuleInit {
  constructor(@Inject(WORKFLOW_RUNTIME) private readonly runtime: WorkflowRuntime) {}

  async onModuleInit(): Promise<void> {
    await this.runtime.initialize();
  }
}
