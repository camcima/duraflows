import { Controller, Post, Query, UsePipes, UseFilters, ValidationPipe } from "@nestjs/common";
import type { ProcessExpiredWorkflowsResult } from "@duraflows/core";
import { WorkflowTimeoutService } from "../services/workflow-timeout.service.js";
import { TimeoutProcessQueryDto } from "./dto/index.js";
import { WorkflowExceptionFilter } from "../filters/workflow-exception.filter.js";

@Controller("workflows/timeouts")
@UseFilters(WorkflowExceptionFilter)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class WorkflowTimeoutController {
  constructor(private readonly timeoutService: WorkflowTimeoutService) {}

  @Post("process")
  async processExpired(@Query() query: TimeoutProcessQueryDto): Promise<ProcessExpiredWorkflowsResult> {
    return this.timeoutService.processExpiredWorkflows(query.limit);
  }
}
