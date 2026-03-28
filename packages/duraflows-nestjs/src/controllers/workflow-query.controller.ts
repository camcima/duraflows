import { Controller, Get, Param, Query, UsePipes, ValidationPipe } from "@nestjs/common";
import type { AvailableWorkflowEvent, WorkflowHistoryRecord } from "@duraflows/core";
import { WorkflowService } from "../services/workflow.service.js";
import { AvailableEventsParamsDto, HistoryQueryDto, HistoryParamsDto } from "./dto/index.js";

@Controller("workflows")
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class WorkflowQueryController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get(":workflowInstanceUuid/events")
  async getAvailableEvents(@Param() params: AvailableEventsParamsDto): Promise<AvailableWorkflowEvent[]> {
    return this.workflowService.getAvailableEvents({
      workflowInstanceUuid: params.workflowInstanceUuid,
    });
  }

  @Get(":workflowInstanceUuid/history")
  async getHistory(
    @Param() params: HistoryParamsDto,
    @Query() query: HistoryQueryDto,
  ): Promise<WorkflowHistoryRecord[]> {
    return this.workflowService.getHistory(params.workflowInstanceUuid, {
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  }
}
