import { IsOptional, IsNumberString, IsUUID } from "class-validator";

export class HistoryQueryDto {
  @IsOptional()
  @IsNumberString()
  limit?: string;

  @IsOptional()
  @IsNumberString()
  offset?: string;
}

export class HistoryParamsDto {
  @IsUUID()
  workflowInstanceUuid!: string;
}
