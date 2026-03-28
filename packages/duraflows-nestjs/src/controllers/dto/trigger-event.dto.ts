import { IsString, IsOptional, IsObject, IsUUID } from "class-validator";

export class TriggerEventDto {
  @IsOptional()
  @IsObject()
  triggerMetadata?: Record<string, unknown>;

  @IsOptional()
  subject?: unknown;
}

export class TriggerEventParamsDto {
  @IsUUID()
  workflowInstanceUuid!: string;

  @IsString()
  eventName!: string;
}
