import { IsString, IsOptional, IsObject, IsIn, IsUUID, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

class CreateInstanceTriggerDto {
  @IsIn(["user", "admin", "system", "timeout"])
  type!: string;

  @IsOptional()
  @IsUUID()
  actorUuid?: string;
}

export class CreateInstanceDto {
  @IsString()
  workflowName!: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ValidateNested()
  @Type(() => CreateInstanceTriggerDto)
  trigger!: CreateInstanceTriggerDto;
}
