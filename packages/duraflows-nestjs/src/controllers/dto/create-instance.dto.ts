import { IsString, IsOptional, IsObject } from "class-validator";

export class CreateInstanceDto {
  @IsString()
  workflowName!: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  triggerMetadata?: Record<string, unknown>;
}
