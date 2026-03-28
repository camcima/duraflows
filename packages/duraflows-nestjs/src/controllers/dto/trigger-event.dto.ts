import { IsString, IsOptional, IsIn, ValidateNested, IsUUID } from "class-validator";
import { Type } from "class-transformer";

class TriggerDto {
  @IsIn(["user", "admin", "system", "timeout"])
  type!: string;

  @IsOptional()
  @IsUUID()
  actorUuid?: string;
}

export class TriggerEventDto {
  @ValidateNested()
  @Type(() => TriggerDto)
  trigger!: TriggerDto;

  @IsOptional()
  subject?: unknown;
}

export class TriggerEventParamsDto {
  @IsUUID()
  workflowInstanceUuid!: string;

  @IsString()
  eventName!: string;
}
