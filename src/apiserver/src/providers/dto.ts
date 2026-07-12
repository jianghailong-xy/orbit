import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

// Phase 1 supports the claude runtime (Anthropic-compatible endpoints); codex is reserved
// for Phase 2. Kept a plain allow-list so a new runtime is a one-line change.
const RUNTIMES = ['claude', 'codex'];

export class CreateModelProviderDto {
  @IsString() @MinLength(1) slug!: string;
  @IsString() @MinLength(1) label!: string;
  @IsOptional() @IsIn(RUNTIMES) runtime?: string;
  @IsString() @MinLength(1) baseUrl!: string;
  /** Plaintext provider API key; stored AES-GCM encrypted, never returned to the browser. */
  @IsString() @MinLength(1) apiKey!: string;
  /** Picker model list: [{ value, label, contextWindow? }]. */
  @IsOptional() @IsArray() models?: { value: string; label: string; contextWindow?: number }[];
  @IsOptional() @IsString() defaultModel?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateModelProviderDto {
  @IsOptional() @IsString() @MinLength(1) label?: string;
  @IsOptional() @IsIn(RUNTIMES) runtime?: string;
  @IsOptional() @IsString() @MinLength(1) baseUrl?: string;
  /** Omit to keep the stored key; provide to rotate it. */
  @IsOptional() @IsString() @MinLength(1) apiKey?: string;
  @IsOptional() @IsArray() models?: { value: string; label: string; contextWindow?: number }[];
  @IsOptional() @IsString() defaultModel?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
