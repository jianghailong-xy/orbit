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
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() appendSystemPrompt?: string;
  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedTools?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) disallowedTools?: string[];
  @IsOptional() @IsIn(PERMISSION_MODES) permissionMode?: string;
  @IsOptional() @IsNumber() maxTurns?: number;
  @IsOptional() @IsNumber() maxBudgetUsd?: number;
  @IsOptional() @IsObject() mcpConfig?: Record<string, unknown>;
  @IsOptional() @IsString() targetRunnerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) targetLabels?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateAgentDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() appendSystemPrompt?: string;
  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allowedTools?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) disallowedTools?: string[];
  @IsOptional() @IsIn(PERMISSION_MODES) permissionMode?: string;
  @IsOptional() @IsNumber() maxTurns?: number;
  @IsOptional() @IsNumber() maxBudgetUsd?: number;
  @IsOptional() @IsObject() mcpConfig?: Record<string, unknown>;
  @IsOptional() @IsString() targetRunnerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) targetLabels?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}
