import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateEnrollmentTokenDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) ttlHours?: number;
}
