import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { PermissionMode } from '@orbit/shared';

const PERMISSION_MODES = Object.values(PermissionMode);

export class CreateAgentDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional() @IsString() description?: string;
  // A built-in provider ("claude"/"codex") or a configured ModelProvider slug (e.g. "deepseek").
  // Kept a plain string (not @IsIn a fixed enum) so custom providers pass; an unknown slug
  // simply falls back to the claude runtime at dispatch (resolveProviderExec).
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() appendSystemPrompt?: string;
  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedTools?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) disallowedTools?: string[];
  @IsOptional() @IsIn(PERMISSION_MODES) permissionMode?: string;
  // Default reasoning effort a new session inherits ('' = model default). Kept a plain string
  // (like the session DTO) so provider-specific values pass — codex adds 'minimal'.
  @IsOptional() @IsString() effort?: string;
  @IsOptional() @IsNumber() maxTurns?: number;
  @IsOptional() @IsNumber() maxBudgetUsd?: number;
  @IsOptional() @IsObject() mcpConfig?: Record<string, unknown>;
  @IsOptional() @IsString() targetRunnerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) targetLabels?: string[];
  // The runner this agent belongs to (set when adding an agent under a runner) and
  // the project directory it runs in. Both are otherwise minted by `orbit register`.
  @IsOptional() @IsString() runnerId?: string;
  @IsOptional() @IsString() workDir?: string;
  @IsOptional() @IsObject() env?: Record<string, string>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoInitGit?: boolean;
  @IsOptional() @IsBoolean() enableWorktree?: boolean;
}

export class UpdateAgentDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() appendSystemPrompt?: string;
  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedTools?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) disallowedTools?: string[];
  @IsOptional() @IsIn(PERMISSION_MODES) permissionMode?: string;
  @IsOptional() @IsString() effort?: string;
  @IsOptional() @IsNumber() maxTurns?: number;
  @IsOptional() @IsNumber() maxBudgetUsd?: number;
  @IsOptional() @IsObject() mcpConfig?: Record<string, unknown>;
  @IsOptional() @IsString() targetRunnerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) targetLabels?: string[];
  @IsOptional() @IsString() runnerId?: string;
  @IsOptional() @IsString() workDir?: string;
  @IsOptional() @IsObject() env?: Record<string, string>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoInitGit?: boolean;
  @IsOptional() @IsBoolean() enableWorktree?: boolean;
}

// The full agent list in the desired sidebar order; each id's index becomes its position.
export class ReorderAgentsDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
}
