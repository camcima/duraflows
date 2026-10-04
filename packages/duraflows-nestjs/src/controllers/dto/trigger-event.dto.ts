import { IsString, IsOptional, IsObject, IsUUID, ValidateIf } from "class-validator";

export class TriggerEventDto {
  // IsOptional skips null; supplied null must fail like a direct runtime call.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  idempotencyKey?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  idempotencyFingerprint?: string;

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
