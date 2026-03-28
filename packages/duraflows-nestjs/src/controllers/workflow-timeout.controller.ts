import { Controller, Post, Query, UsePipes, ValidationPipe } from "@nestjs/common";
import type { ProcessExpiredWorkflowsResult } from "@camcima/duraflows-core";
import { WorkflowTimeoutService } from "../services/workflow-timeout.service.js";
import { TimeoutProcessQueryDto } from "./dto/index.js";

@Controller("workflows/timeouts")
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class WorkflowTimeoutController {
  constructor(private readonly timeoutService: WorkflowTimeoutService) {}

  @Post("process")
  async processExpired(@Query() query: TimeoutProcessQueryDto): Promise<ProcessExpiredWorkflowsResult> {
    return this.timeoutService.processExpiredWorkflows(query.limit ? parseInt(query.limit, 10) : undefined);
  }
}
