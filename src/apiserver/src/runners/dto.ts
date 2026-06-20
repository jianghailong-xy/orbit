import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateEnrollmentTokenDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) ttlHours?: number;
}

export class UpdateRunnerDto {
  // Empty string clears the alias and falls back to the machine name.
  @IsOptional() @IsString() @MaxLength(60) displayName?: string;
  // Max sessions the runner runs at once; the claim queue gates on this. Floor of
  // 1 (0 would stall the runner); 64 is a sanity ceiling against a fat-fingered value.
  @IsOptional() @IsInt() @Min(1) @Max(64) maxConcurrent?: number;
}
