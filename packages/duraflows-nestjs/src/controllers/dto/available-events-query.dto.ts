import { IsUUID } from "class-validator";

export class AvailableEventsParamsDto {
  @IsUUID()
  workflowInstanceUuid!: string;
}
