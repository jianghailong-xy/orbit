import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsPublicId } from '../common/public-id';
import { ACCOUNT_ID_PATTERN } from '../runners/dto';
import { MODEL_ROUTING_ENGINES } from '../tasks/model-routing';

/** The most SubAgents one session may run at once that the owner can set (docs/subagent-design.md §7). */
export const SUBAGENTS_MAX_RUNNING_LIMIT = 16;

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
  /** In place of workDir: a new folder of this name under the runner's reposRoot, made by the runner before
   *  this workspace's first session starts (the claim's createWorkDir). Needs runnerId. */
  @IsOptional() @IsString() newFolder?: string;
  /** In place of workDir and newFolder: a clone of one of the caller's GitHub repositories, { repoId, ref?, folder? }
   *  (docs/github-workspace-design.md §5.3), into `<reposRoot>/<folder>`. Needs runnerId. Read and refused as POST
   *  /sessions `newWorkspace.github` is; the runner clones it on its next reconcile, and sessions wait for the clone. */
  @IsOptional() @IsObject() github?: Record<string, unknown>;
  // Explicit repository address; when empty, the runner's directory probe can backfill it from
  // origin. Used for project integration, never to clone or change the checkout.
  @IsOptional() @IsString() repoUrl?: string;
  @IsOptional() @IsObject() env?: Record<string, string>;
  // The Codex account this workspace's Codex sessions run on: the id of a slot its runner reports,
  // or `default`. A path is never accepted — dispatch resolves the id on the runner that runs the
  // session. null is Automatic: each new session starts on the runner's account whose quota resets
  // soonest (automaticAccount), and moves off it when its usage limit stops the session.
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) codexAccount?: string | null;
  /** The Claude account this workspace's Claude sessions run on. Same rules as codexAccount: null is
   *  Automatic, `default` pins them to Default. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) claudeAccount?: string | null;
  /** The Antigravity Google account this workspace's Antigravity sessions run on. Same rules again. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) antigravityAccount?: string | null;
  /** The Kimi Code account this workspace's Kimi sessions run on. Same rules again. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) kimiAccount?: string | null;
  /** The Cursor CLI account this workspace's Cursor CLI sessions run on. Same rules again. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) cursorAccount?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoInitGit?: boolean;
  @IsOptional() @IsBoolean() enableWorktree?: boolean;
  // Branch this workspace's sessions merge into by default (null = the runner auto-detects
  // main, else master). Also written implicitly when a session merges to an explicit target.
  @IsOptional() @IsString() defaultMergeTarget?: string;
  // Smart model selection's former per-Agent switch (docs/model-routing-design.md §7.2). Still
  // accepted and returned, but no longer read (owner, 2026-11-20): the account's switch alone decides
  // whether task runs are routed. The owner's alone: it decides what runs cost, so the agent tools' whitelist
  // (runner-agents.controller.ts ORCHESTRATOR_WORKSPACE_CREATE_FIELDS) deliberately leaves it out.
  @IsOptional() @IsBoolean() modelRouting?: boolean;
  @IsOptional() @IsIn(['cost', 'balance', 'intelligence'])
  modelRoutingOptimizeFor?: 'cost' | 'balance' | 'intelligence';
  // The former per-Agent list of engines smart selection could move task runs to (§6). Still
  // accepted and returned, but no longer read (owner, 2026-11-20); only the owner's to name, for the
  // same reason as the switch.
  @IsOptional() @IsArray() @ArrayMaxSize(MODEL_ROUTING_ENGINES.length)
  @IsIn(MODEL_ROUTING_ENGINES, { each: true })
  modelRoutingProviders?: string[];
  // SubAgents (docs/subagent-design.md §6.2, §7): whether this Agent's sessions may delegate, and how many
  // of one session's SubAgents run at once. Human-only like modelRouting: the runner's whitelist
  // (ORCHESTRATOR_WORKSPACE_CREATE_FIELDS) leaves them out and refuses them by name (HUMAN_ONLY_WORKSPACE_FIELDS).
  @IsOptional() @IsBoolean() subagentsEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(SUBAGENTS_MAX_RUNNING_LIMIT) subagentsMaxRunning?: number;
  // Workflows (docs/subagent-workflow-design.md §6): whether this Agent's sessions may start a workflow, which also
  // takes SubAgents on. Human-only for the same reason as subagentsEnabled (HUMAN_ONLY_WORKSPACE_FIELDS).
  @IsOptional() @IsBoolean() workflowsEnabled?: boolean;
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
  /** See CreateWorkspaceDto.repoUrl — the same recorded remote, restated or corrected here. */
  @IsOptional() @IsString() repoUrl?: string;
  @IsOptional() @IsObject() env?: Record<string, string>;
  /** See CreateWorkspaceDto.codexAccount. Absent leaves the choice alone; null clears it. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) codexAccount?: string | null;
  /** See CreateWorkspaceDto.claudeAccount. Absent leaves the choice alone; null clears it. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) claudeAccount?: string | null;
  /** See CreateWorkspaceDto.antigravityAccount. Absent leaves the choice alone; null clears it. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) antigravityAccount?: string | null;
  /** See CreateWorkspaceDto.kimiAccount. Absent leaves the choice alone; null clears it. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) kimiAccount?: string | null;
  /** See CreateWorkspaceDto.cursorAccount. Absent leaves the choice alone; null clears it. */
  @IsOptional() @IsString() @Matches(ACCOUNT_ID_PATTERN) cursorAccount?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoInitGit?: boolean;
  @IsOptional() @IsBoolean() enableWorktree?: boolean;
  @IsOptional() @IsString() defaultMergeTarget?: string;
  /** See CreateWorkspaceDto.modelRouting. Absent leaves the switch as it is. */
  @IsOptional() @IsBoolean() modelRouting?: boolean;
  @IsOptional() @IsIn(['cost', 'balance', 'intelligence'])
  modelRoutingOptimizeFor?: 'cost' | 'balance' | 'intelligence';
  /** See CreateWorkspaceDto.modelRoutingProviders. Absent leaves the list as it is; [] empties it. */
  @IsOptional() @IsArray() @ArrayMaxSize(MODEL_ROUTING_ENGINES.length)
  @IsIn(MODEL_ROUTING_ENGINES, { each: true })
  modelRoutingProviders?: string[];
  /** See CreateWorkspaceDto.subagentsEnabled. Absent leaves each as it is. */
  @IsOptional() @IsBoolean() subagentsEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(SUBAGENTS_MAX_RUNNING_LIMIT) subagentsMaxRunning?: number;
  /** See CreateWorkspaceDto.workflowsEnabled. Absent leaves the switch as it is. */
  @IsOptional() @IsBoolean() workflowsEnabled?: boolean;
  /**
   * How finished work reaches a protected GitHub branch (docs/design/protected-branch-landing.md §3, §11.1): the
   * default PULL_REQUEST, or PUSH_AS_ME, which lands with the owner's own GitHub authorization. The owner's signed-in
   * clients only (WorkspacesController); absent leaves it as it is.
   */
  @IsOptional() @IsIn(['PULL_REQUEST', 'PUSH_AS_ME'])
  landingMode?: 'PULL_REQUEST' | 'PUSH_AS_ME';
}

// The full workspace list in the desired sidebar order; each id's index becomes its position.
export class ReorderWorkspacesDto {
  @IsArray() @IsPublicId({ each: true }) ids!: string[];
}
