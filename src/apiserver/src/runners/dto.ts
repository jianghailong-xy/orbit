import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateEnrollmentTokenDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) ttlHours?: number;
}

export class UpdateRunnerDto {
  // Empty string clears the alias and falls back to the machine name.
  @IsOptional() @IsString() @MaxLength(60) displayName?: string;
}
