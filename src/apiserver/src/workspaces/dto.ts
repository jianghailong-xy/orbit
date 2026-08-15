import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional() @IsString() description?: string;
  /** @deprecated Accepted for old clients, but a workspace no longer holds a provider — it is a
   *  per-session binding, defaulted from what this project last ran on (workspace-provider.ts). */
  @IsOptional() @IsString() provider?: string;
  /** @deprecated Accepted for old clients, but runtime defaults are no longer stored per workspace. */
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() appendSystemPrompt?: string;
  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) disallowedTools?: string[];
  // Default reasoning effort a new session inherits ('' = model default). Kept a plain string
  // (like the session DTO) so provider-specific values pass — codex adds 'minimal'.
  @IsOptional() @IsString() effort?: string;
  @IsOptional() @IsPublicId() targetRunnerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) targetLabels?: string[];
  // The runner this workspace belongs to (set when adding a workspace under a runner) and
  // the project directory it runs in. Both are otherwise minted by `orbit register`.
  @IsOptional() @IsPublicId() runnerId?: string;
  @IsOptional() @IsString() workDir?: string;
  @IsOptional() @IsObject() env?: Record<string, string>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoInitGit?: boolean;
  @IsOptional() @IsBoolean() enableWorktree?: boolean;
  // Opt-in: may this workspace's sessions orchestrate other sessions via orbit mcp (default off).
  @IsOptional() @IsBoolean() enableOrchestration?: boolean;
  // Branch this workspace's sessions merge into by default (null = the runner auto-detects
  // main, else master). Also written implicitly when a session merges to an explicit target.
  @IsOptional() @IsString() defaultMergeTarget?: string;
}

export class UpdateWorkspaceDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() description?: string;
  /** @deprecated Accepted for old clients, but ignored — see CreateWorkspaceDto.provider. */
  @IsOptional() @IsString() provider?: string;
  /** @deprecated Accepted for old clients, but ignored by workspace updates. */
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() appendSystemPrompt?: string;
  @IsOptional() @IsString() systemPrompt?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) disallowedTools?: string[];
  @IsOptional() @IsString() effort?: string;
  @IsOptional() @IsPublicId() targetRunnerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) targetLabels?: string[];
  @IsOptional() @IsPublicId() runnerId?: string;
  @IsOptional() @IsString() workDir?: string;
  @IsOptional() @IsObject() env?: Record<string, string>;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoInitGit?: boolean;
  @IsOptional() @IsBoolean() enableWorktree?: boolean;
  @IsOptional() @IsBoolean() enableOrchestration?: boolean;
  @IsOptional() @IsString() defaultMergeTarget?: string;
}

// The full workspace list in the desired sidebar order; each id's index becomes its position.
export class ReorderWorkspacesDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
}

// Grant (or revoke) session orchestration on every workspace this account owns at once. Still a
// per-workspace grant — this writes each row, so a workspace can be flipped back on its own
// afterwards — it just spares the user one visit per workspace.
export class SetOrchestrationDto {
  @IsBoolean() enabled!: boolean;
}
