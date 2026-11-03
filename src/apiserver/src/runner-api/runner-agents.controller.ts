import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { Workspace, Runner } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from '../workspaces/dto';
import { RealtimeService } from '../realtime/realtime.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { namesWorkspaceCardField, requireWorkspaceWriteApproval } from './runner-workspace-approval';

// The exact create contract shared by the runner HTTP route, MCP agent_create and
// `orbit agent create`. Keep this as one literal: runner-go's parity test reads it and compares all
// three surfaces, so adding a field to only one door fails the suite instead of silently shipping.
// Deliberately EXCLUDES enabled, and every other field a workspace must not control about itself
// or another workspace. (Orchestration is no workspace field at all: it is the account's own
// switch, written only through the owner's preferences — a user route no runner token reaches.)
// `sanitizeWorkspaceWrite` iterates this list, so it is also the HTTP route's actual whitelist rather
// than documentation beside a different implementation.
export const ORCHESTRATOR_WORKSPACE_CREATE_FIELDS = [
  'name',
  'description',
  'systemPrompt',
  'appendSystemPrompt',
  'workDir',
  'runnerId',
  'enableWorktree',
  'env',
  'defaultMergeTarget',
] as const;

export type OrchestratorWorkspaceInput = {
  name?: string;
  description?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  workDir?: string;
  runnerId?: string;
  enableWorktree?: boolean;
  env?: Record<string, string>;
  defaultMergeTarget?: string;
};

type OrchestratorWorkspaceRecord = Pick<
  Workspace,
  | 'id'
  | 'name'
  | 'description'
  | 'workDir'
  | 'runnerId'
  | 'enableWorktree'
  | 'defaultMergeTarget'
> & {
  /** Derived, not stored: what this project last ran on (workspaces/workspace-provider.ts). */
  lastProvider?: string;
  runner?: { id: string; name: string; displayName: string | null } | null;
};

/**
 * Workspace management for in-session orchestrators, reached by the `orbit mcp` server with the
 * machine's runner token. Tenant scope is the runner's owner. Gated on the CALLING session
 * (X-Orbit-Session-Id) being allowed to orchestrate — the same guard as session_create — so an
 * account with Session orchestration off, or a direct token call without an orchestrating session,
 * is refused. What decides a workspace's next session is written only against the account owner's
 * card (runner-workspace-approval.ts).
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerAgentsController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
  ) {}

  // Both paths are live on purpose: `workspaces` is the name, `agents` is what every already-
  // shipped client (web build, TestFlight iOS/macOS, field runners) still calls. The alias goes
  // away once those have all rolled over; until then removing it is a hard break, not a cleanup.
  @Get(['workspaces', 'agents'])
  async listWorkspaces(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
  ) {
    await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const workspaces = await this.workspaces.list(runner.ownerId);
    return workspaces.map((workspace) => this.toOrchestrationView(workspace));
  }

  @Post(['workspaces', 'agents'])
  async createWorkspace(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Body(PublicIdPipe.forFields('runnerId')) body: unknown,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const sanitized = sanitizeWorkspaceWrite(body);
    if (!sanitized.name) throw new BadRequestException('name is required');
    await requireWorkspaceWriteApproval(this.prisma, scope, null, sanitized);
    // Bind to the calling runner by default so the new workspace can actually run sessions.
    const workspace = await this.workspaces.create(
      runner.ownerId,
      { ...sanitized, runnerId: sanitized.runnerId ?? runner.id } as CreateWorkspaceDto,
    );
    // Push it to the owner's control-plane stream so their workspace list shows it live instead of
    // only after a manual reload — the workspace-side mirror of TasksService's publishTaskChanged.
    // Scoped via the calling session, which assertOrchestrator returned as this owner's.
    // A brand-new workspace cannot yet be referenced by an existing Task row.
    this.realtime.publishWorkspaceChanged(scope, workspace.id, false);
    return this.toOrchestrationView(workspace);
  }

  @Patch(['workspaces/:id', 'agents/:id'])
  async updateWorkspace(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body(PublicIdPipe.forFields('runnerId')) body: unknown,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const sanitized = sanitizeWorkspaceWrite(body);
    if (namesWorkspaceCardField(sanitized)) {
      // Another account's workspace is not found, card or no card, before anything is said about one.
      await this.workspaces.get(runner.ownerId, id);
      await requireWorkspaceWriteApproval(this.prisma, scope, id, sanitized);
    }
    const workspace = await this.workspaces.update(runner.ownerId, id, sanitized as UpdateWorkspaceDto);
    // Name/model/runner changes are rendered through Task.assignee, so existing rows may move.
    this.realtime.publishWorkspaceChanged(scope, id, true);
    return this.toOrchestrationView(workspace);
  }

  /** Never expose engine credentials or policy prompts to the model invoking MCP. */
  private toOrchestrationView(workspace: OrchestratorWorkspaceRecord) {
    return {
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      lastProvider: workspace.lastProvider,
      workDir: workspace.workDir,
      runnerId: workspace.runnerId,
      enableWorktree: workspace.enableWorktree,
      defaultMergeTarget: workspace.defaultMergeTarget,
      ...(workspace.runner
        ? {
            runner: {
              id: workspace.runner.id,
              name: workspace.runner.name,
              displayName: workspace.runner.displayName,
            },
          }
        : {}),
    };
  }
}

/** Whitelist the caller's fields (drops `enabled` etc. a workspace must not control). The write
 *  and the owner's card about it both read a body through this, so they cannot read it two ways.
 *  This body is a plain type, not a DTO class, so the global ValidationPipe has no metatype
 *  to check — the free-form fields are validated here instead.
 *
 *  `runnerId` arrives already decoded: for that same reason `@IsPublicId` cannot reach it, so
 *  both routes bind `@Body(PublicIdPipe.forFields('runnerId'))`. The CLI and MCP hand back the
 *  base62 id this API gave them (`PublicIdInterceptor` — this controller is agent-facing, not
 *  machine protocol), and unconverted that string reached `prisma.runner.findFirst` as a bare
 *  P2023 500. */
export function sanitizeWorkspaceWrite(body: unknown): OrchestratorWorkspaceInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('workspace body must be an object');
  }
  const input = body as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const field of ORCHESTRATOR_WORKSPACE_CREATE_FIELDS) {
    if (field === 'enableWorktree') {
      if (input[field] !== undefined && typeof input[field] !== 'boolean') {
        throw new BadRequestException(`${field} must be a boolean`);
      }
      if (input[field] !== undefined) sanitized[field] = input[field];
      continue;
    }
    if (field === 'env') {
      const env = normalizeEnv(input[field]);
      if (env !== undefined) sanitized[field] = env;
      continue;
    }
    const value = optionalString(input, field);
    if (field === 'name' && value !== undefined && value.length === 0) {
      throw new BadRequestException('name cannot be empty');
    }
    // The pipe above only decodes ids that are PRESENT — `""` and `"   "` fail its trim test,
    // so it skips them and they arrive here verbatim. Neither is a spelling of an id.
    if (field === 'runnerId' && value !== undefined && value.trim() === '') {
      throw new BadRequestException('invalid runnerId');
    }
    if (value !== undefined) sanitized[field] = value;
  }
  return sanitized as OrchestratorWorkspaceInput;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${key} must be a string`);
  return value;
}

/** The runner decodes `env` into a map[string]string, so a nested/non-string value would
 *  break every subsequent claim for that workspace. Reject it at the write instead. */
function normalizeEnv(env: unknown): Record<string, string> | undefined {
  if (env === undefined || env === null) return undefined;
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new BadRequestException('env must be an object of string values');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new BadRequestException(`env.${k} must be a string`);
    out[k] = v;
  }
  return out;
}
