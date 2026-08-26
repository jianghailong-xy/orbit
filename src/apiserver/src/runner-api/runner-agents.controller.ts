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
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from '../workspaces/dto';
import { RealtimeService } from '../realtime/realtime.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

// The exact create contract shared by the runner HTTP route, MCP agent_create and
// `orbit agent create`. Keep this as one literal: runner-go's parity test reads it and compares all
// three surfaces, so adding a field to only one door fails the suite instead of silently shipping.
// Deliberately EXCLUDES enableOrchestration (and enabled): the orchestration permission is
// human-granted in the web UI only — a workspace must never be able to grant it to itself or
// another workspace (privilege escalation). `sanitize` iterates this list, so it is also the HTTP
// route's actual whitelist rather than documentation beside a different implementation.
export const ORCHESTRATOR_WORKSPACE_CREATE_FIELDS = [
  'name',
  'description',
  'systemPrompt',
  'appendSystemPrompt',
  'workDir',
  'runnerId',
  'repoUrl',
  'enableWorktree',
  'env',
  'defaultMergeTarget',
] as const;

type OrchestratorWorkspaceInput = {
  name?: string;
  description?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  workDir?: string;
  runnerId?: string;
  repoUrl?: string;
  enableWorktree?: boolean;
  env?: unknown;
  defaultMergeTarget?: string;
};

type OrchestratorWorkspaceRecord = Pick<
  Workspace,
  | 'id'
  | 'name'
  | 'description'
  | 'workDir'
  | 'runnerId'
  | 'repoUrl'
  | 'provisionState'
  | 'provisionError'
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
 * (X-Orbit-Session-Id) having an orchestration-enabled workspace — the same guard as session_create —
 * so a non-orchestrator workspace, or a direct token call without an orchestrating session, is refused.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerAgentsController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
    private readonly realtime: RealtimeService,
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
    const sanitized = this.sanitize(body, runner.id);
    if (!sanitized.name) throw new BadRequestException('name is required');
    // Bind to the calling runner by default so the new workspace can actually run sessions.
    // enableOrchestration is pinned off rather than left absent: absent means "seed from the
    // account default", which would let an orchestrator mint itself a second orchestrator — the
    // very escalation `sanitize` drops the field to prevent. The grant stays a human act.
    const workspace = await this.workspaces.create(runner.ownerId, {
      ...sanitized,
      enableOrchestration: false,
    } as CreateWorkspaceDto);
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
    const workspace = await this.workspaces.update(
      runner.ownerId,
      id,
      this.sanitize(body) as UpdateWorkspaceDto,
    );
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
      repoUrl: workspace.repoUrl,
      // These three values are the provisioning receipt. A create returns CLONING before the
      // runner starts, and agent_list keeps returning the same fields until it becomes READY or
      // FAILED; the caller never has to mistake "an id was allocated" for "git clone worked".
      provisionState: workspace.provisionState,
      provisionError: workspace.provisionError,
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

  /** Whitelist the caller's fields (drops enableOrchestration/enabled etc. a workspace must not
   *  control). On create, default runnerId to the calling runner so the workspace can run.
   *  This body is a plain type, not a DTO class, so the global ValidationPipe has no metatype
   *  to check — the free-form fields are validated here instead.
   *
   *  `runnerId` arrives already decoded: for that same reason `@IsPublicId` cannot reach it, so
   *  both routes bind `@Body(PublicIdPipe.forFields('runnerId'))`. The CLI and MCP hand back the
   *  base62 id this API gave them (`PublicIdInterceptor` — this controller is agent-facing, not
   *  machine protocol), and unconverted that string reached `prisma.runner.findFirst` as a bare
   *  P2023 500. `defaultRunnerId` is the calling runner's own UUID, so it needs no decoding. */
  private sanitize(body: unknown, defaultRunnerId?: string): OrchestratorWorkspaceInput {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('workspace body must be an object');
    }
    const input = body as Record<string, unknown>;
    const creating = defaultRunnerId !== undefined;
    const sanitized: Record<string, unknown> = {};
    for (const field of ORCHESTRATOR_WORKSPACE_CREATE_FIELDS) {
      // repoUrl starts provisioning, so it is create-only. The update path keeps using the same
      // safe config contract for every other field without accidentally becoming a clone retry.
      if (!creating && field === 'repoUrl') continue;
      if (field === 'enableWorktree') {
        if (input[field] !== undefined && typeof input[field] !== 'boolean') {
          throw new BadRequestException(`${field} must be a boolean`);
        }
        if (input[field] !== undefined) sanitized[field] = input[field];
        continue;
      }
      if (field === 'env') {
        const env = this.normalizeEnv(input[field]);
        if (env !== undefined) sanitized[field] = env;
        continue;
      }
      const value = this.optionalString(input, field);
      if (field === 'name' && value !== undefined && value.length === 0) {
        throw new BadRequestException('name cannot be empty');
      }
      // The pipe above only decodes ids that are PRESENT — `""` and `"   "` fail its trim test,
      // so it skips them and they arrive here verbatim. Neither is a spelling of an id.
      if (field === 'runnerId' && value !== undefined && value.trim() === '') {
        throw new BadRequestException('invalid runnerId');
      }
      // Same cap as CreateWorkspaceDto. Resolution and credentials remain git's answer on the
      // runner; this only prevents an unbounded control-plane value.
      if (field === 'repoUrl' && value !== undefined && value.length > 2048) {
        throw new BadRequestException('repoUrl must be shorter than or equal to 2048 characters');
      }
      if (value !== undefined) sanitized[field] = value;
    }
    if (creating && sanitized.runnerId === undefined) sanitized.runnerId = defaultRunnerId;
    return sanitized as OrchestratorWorkspaceInput;
  }

  private optionalString(body: Record<string, unknown>, key: string): string | undefined {
    const value = body[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new BadRequestException(`${key} must be a string`);
    return value;
  }

  /** The runner decodes `env` into a map[string]string, so a nested/non-string value would
   *  break every subsequent claim for that workspace. Reject it at the write instead. */
  private normalizeEnv(env: unknown): Record<string, string> | undefined {
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
}
