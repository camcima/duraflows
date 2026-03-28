import { Controller, Post, Param, Body, UsePipes, ValidationPipe } from "@nestjs/common";
import type { WorkflowExecutionResult } from "@duraflows/core";
import { WorkflowService } from "../services/workflow.service.js";
import { TriggerEventDto, TriggerEventParamsDto } from "./dto/index.js";

@Controller("workflows")
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class WorkflowEventController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post(":workflowInstanceUuid/events/:eventName")
  async triggerEvent(
    @Param() params: TriggerEventParamsDto,
    @Body() body: TriggerEventDto,
  ): Promise<WorkflowExecutionResult> {
    return this.workflowService.triggerEvent({
      workflowInstanceUuid: params.workflowInstanceUuid,
      eventName: params.eventName,
      subject: body.subject,
      triggerMetadata: body.triggerMetadata,
    });
  }
}
