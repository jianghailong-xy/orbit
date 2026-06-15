import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  title!: string;

  /** Instruction handed to Claude Code. Defaults to `title` when omitted. */
  @IsOptional() @IsString() prompt?: string;
  @IsOptional() @IsObject() input?: Record<string, unknown>;
  @IsOptional() @IsString() agentId?: string;
  @IsOptional() @IsString() assignedRunnerId?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() estimates?: string;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() scheduledAt?: string;
  /** Create directly as QUEUED (claimable by a runner) instead of DRAFT. */
  @IsOptional() @IsBoolean() enqueue?: boolean;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(1) title?: string;
  @IsOptional() @IsString() prompt?: string;
  @IsOptional() @IsObject() input?: Record<string, unknown>;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() estimates?: string;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() scheduledAt?: string;
  @IsOptional() @IsString() assignedRunnerId?: string;
}
