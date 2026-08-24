import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';

export class ProviderFallbackDto {
  @IsString() @MinLength(1) provider!: string;
  @IsOptional() @IsString() @MinLength(1) model?: string;
}

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
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => ProviderFallbackDto)
  providerFallbacks?: ProviderFallbackDto[];
  @IsOptional() @IsBoolean() canCreateTasks?: boolean;
  @IsOptional() @IsBoolean() canDelegate?: boolean;
  @IsOptional() @IsInt() @Min(1) maxConcurrentTasks?: number;
  // Default reasoning effort a new session inherits ('' = model default). Kept a plain string
  // (like the session DTO) so provider-specific values pass — codex adds 'minimal'.
  @IsOptional() @IsString() effort?: string;
  @IsOptional() @IsPublicId() targetRunnerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) targetLabels?: string[];
  // The runner this workspace belongs to (set when adding a workspace under a runner) and
  // the project directory it runs in. Both are otherwise minted by `orbit register`.
  @IsOptional() @IsPublicId() runnerId?: string;
  @IsOptional() @IsString() workDir?: string;
  // The git remote this workspace is made from. With no `workDir`, this is a clone request: the
  // row is written CLONING and its runner is told to clone into `<reposRoot>/<owner>-<repo>` on
  // its next heartbeat. With a `workDir`, it records which repository a checkout the user already
  // had is — the "reuse this checkout" half of the create flow, which clones nothing.
  //
  // Only length-checked here. Whether the URL resolves, and whether this machine may read it, is
  // git's answer to give on the runner, and it comes back as git's own stderr.
  @IsOptional() @IsString() @MaxLength(2048) repoUrl?: string;
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
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => ProviderFallbackDto)
  providerFallbacks?: ProviderFallbackDto[];
  @IsOptional() @IsBoolean() canCreateTasks?: boolean;
  @IsOptional() @IsBoolean() canDelegate?: boolean;
  @IsOptional() @IsInt() @Min(1) maxConcurrentTasks?: number;
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

/**
 * Re-arm the clone on a workspace whose last one failed — the failure card's retry, change-URL and
 * change-machine exits, which are one path and not three: each of them is the same dispatch made
 * again, differing only in what it is told this time.
 *
 * Both fields optional: retrying unchanged is the common case, and omitting one keeps whatever the
 * workspace already holds.
 */
export class RedispatchCloneDto {
  @IsOptional() @IsString() @MaxLength(2048) repoUrl?: string;
  @IsOptional() @IsPublicId() runnerId?: string;
}
