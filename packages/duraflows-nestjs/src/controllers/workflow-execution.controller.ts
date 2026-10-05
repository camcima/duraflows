import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  NotFoundException,
  UseFilters,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { InvalidArgumentError } from "@duraflows/core";
import { WorkflowService } from "../services/workflow.service.js";
import { TriggerEventDto, TriggerEventParamsDto, TimeoutProcessQueryDto } from "./dto/index.js";
import { WorkflowExceptionFilter } from "../filters/workflow-exception.filter.js";

@Controller("workflows")
@UseFilters(WorkflowExceptionFilter)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class WorkflowExecutionController {
  constructor(private readonly service: WorkflowService) {}

  @Post(":workflowInstanceUuid/executions/:eventName")
  async enqueue(@Param() params: TriggerEventParamsDto, @Body() body: TriggerEventDto) {
    if (body.idempotencyKey === undefined) throw new InvalidArgumentError("enqueueEvent requires idempotencyKey");
    return this.service.enqueueEvent({ ...body, ...params, idempotencyKey: body.idempotencyKey });
  }

  @Get("executions/:executionUuid")
  async get(@Param("executionUuid", new ParseUUIDPipe()) uuid: string) {
    const execution = await this.service.getExecution(uuid);
    if (!execution) throw new NotFoundException("Durable execution not found");
    return execution;
  }

  @Post("executions/process")
  async process(@Query() query: TimeoutProcessQueryDto) {
    return this.service.processPendingExecutions({ limit: query.limit });
  }

  @Post("executions/:executionUuid/retry")
  async retry(@Param("executionUuid", new ParseUUIDPipe()) uuid: string) {
    return this.service.retryExecution(uuid);
  }

  @Post("executions/:executionUuid/cancel")
  async cancel(@Param("executionUuid", new ParseUUIDPipe()) uuid: string) {
    return this.service.cancelExecution(uuid);
  }
}
