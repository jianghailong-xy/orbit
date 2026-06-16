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
  /** Start a long-lived interactive session (Route B) instead of a one-shot run. */
  @IsOptional() @IsBoolean() interactive?: boolean;
  /** Per-session overrides; null falls back to the agent, then a server default. */
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() permissionMode?: string;
}

/** Body of POST /tasks/:id/turns — a user message for a live interactive session. */
export class RunTurnDto {
  @IsString() @MinLength(1) clientTurnId!: string;
  @IsString() @MinLength(1) content!: string;
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
