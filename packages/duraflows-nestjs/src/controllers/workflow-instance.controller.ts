import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UsePipes,
  UseFilters,
  ValidationPipe,
  NotFoundException,
  ParseUUIDPipe,
} from "@nestjs/common";
import type { WorkflowInstance } from "@duraflows/core";
import { WorkflowService } from "../services/workflow.service.js";
import { CreateInstanceDto } from "./dto/index.js";
import { WorkflowExceptionFilter } from "../filters/workflow-exception.filter.js";

@Controller("workflows")
@UseFilters(WorkflowExceptionFilter)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class WorkflowInstanceController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post()
  async createInstance(@Body() body: CreateInstanceDto): Promise<WorkflowInstance> {
    return this.workflowService.createInstance({
      workflowName: body.workflowName,
      context: body.context,
      metadata: body.metadata,
      triggerMetadata: body.triggerMetadata,
    });
  }

  @Get(":uuid")
  async getInstance(@Param("uuid", new ParseUUIDPipe()) uuid: string): Promise<WorkflowInstance> {
    const instance = await this.workflowService.getInstance(uuid);
    if (!instance) {
      throw new NotFoundException(`Workflow instance "${uuid}" not found`);
    }
    return instance;
  }
}
