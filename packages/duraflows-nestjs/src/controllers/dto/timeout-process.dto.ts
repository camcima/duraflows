import { IsOptional, IsNumberString } from "class-validator";

export class TimeoutProcessQueryDto {
  @IsOptional()
  @IsNumberString()
  limit?: string;
}
