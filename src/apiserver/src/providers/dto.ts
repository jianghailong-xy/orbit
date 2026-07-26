import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

// Custom providers borrow a built-in runtime: `claude` for Anthropic-compatible endpoints,
// `codex` for OpenAI-compatible ones (Gemini's OpenAI endpoint, OpenAI, etc.). The runner
// translates a codex provider's OPENAI_BASE_URL into codex `-c model_providers.*` overrides.
const RUNTIMES = ['claude', 'codex'];

export class CreateModelProviderDto {
  /** Preferred dispatch identifier. Normally omitted: the server derives one from the preset or
   *  the label and suffixes it until it's free, since nothing outside the DB refers to it. */
  @IsOptional() @IsString() slug?: string;
  @IsString() @MinLength(1) label!: string;
  @IsOptional() @IsIn(RUNTIMES) runtime?: string;
  @IsString() @MinLength(1) baseUrl!: string;
  /** Plaintext provider API key; stored AES-GCM encrypted, never returned to the browser. */
  @IsString() @MinLength(1) apiKey!: string;
  /** Picker model list: [{ value, label, contextWindow? }]. Ignored when `presetSlug` is set. */
  @IsOptional() @IsArray() models?: { value: string; label: string; contextWindow?: number }[];
  @IsOptional() @IsString() defaultModel?: string;
  /** The vendor preset (@orbit/shared PROVIDER_PRESETS) this provider is being created from: its
   *  identity for life. */
  @IsOptional() @IsString() presetSlug?: string;
  /** Whether that preset also owns the model list — the default when a preset is named. Pass false
   *  to start out maintaining it yourself. */
  @IsOptional() @IsBoolean() followsPreset?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

// Validate an endpoint + freshly-typed key before saving. Stateless: nothing is persisted.
export class TestModelProviderDto {
  @IsString() @MinLength(1) baseUrl!: string;
  @IsString() @MinLength(1) apiKey!: string;
  /** Model to probe with; the picker sends the default (or the first) model. */
  @IsOptional() @IsString() model?: string;
  /** Which dialect to probe: claude → Anthropic Messages, codex → OpenAI chat completions. */
  @IsOptional() @IsIn(RUNTIMES) runtime?: string;
}

export class UpdateModelProviderDto {
  @IsOptional() @IsString() @MinLength(1) label?: string;
  @IsOptional() @IsIn(RUNTIMES) runtime?: string;
  @IsOptional() @IsString() @MinLength(1) baseUrl?: string;
  /** Omit to keep the stored key; provide to rotate it. */
  @IsOptional() @IsString() @MinLength(1) apiKey?: string;
  @IsOptional() @IsArray() models?: { value: string; label: string; contextWindow?: number }[];
  @IsOptional() @IsString() defaultModel?: string;
  /** Hand the model list back to the row (false) or to its preset (true); omit to leave ownership
   *  as it is. The vendor identity itself is fixed at creation. */
  @IsOptional() @IsBoolean() followsPreset?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
