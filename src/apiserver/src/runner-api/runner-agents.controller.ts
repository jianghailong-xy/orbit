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

// Fields an in-session orchestrator may set on a workspace. Deliberately EXCLUDES
// enableOrchestration (and enabled): the orchestration permission is human-granted in the web
// UI only — a workspace must never be able to grant it to itself or another workspace (privilege
// escalation). Anything not listed here is dropped by `sanitize` before hitting the service.
type OrchestratorWorkspaceInput = {
  name?: string;
  description?: string;
  provider?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  workDir?: string;
  runnerId?: string;
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
    @Body() body: unknown,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const sanitized = this.sanitize(body, runner.id);
    if (!sanitized.name) throw new BadRequestException('name is required');
    // Bind to the calling runner by default so the new workspace can actually run sessions.
    const workspace = await this.workspaces.create(
      runner.ownerId,
      sanitized as CreateWorkspaceDto,
    );
    // Push it to the owner's control-plane stream so their workspace list shows it live instead of
    // only after a manual reload — the workspace-side mirror of TasksService's publishTaskChanged.
    // Scoped via the calling session, which assertOrchestrator returned as this owner's.
    this.realtime.publishWorkspaceChanged(scope, workspace.id);
    return this.toOrchestrationView(workspace);
  }

  @Patch(['workspaces/:id', 'agents/:id'])
  async updateWorkspace(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() body: unknown,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const workspace = await this.workspaces.update(
      runner.ownerId,
      id,
      this.sanitize(body) as UpdateWorkspaceDto,
    );
    this.realtime.publishWorkspaceChanged(scope, id);
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

  /** Whitelist the caller's fields (drops enableOrchestration/enabled etc. a workspace must not
   *  control). On create, default runnerId to the calling runner so the workspace can run.
   *  This body is a plain type, not a DTO class, so the global ValidationPipe has no metatype
   *  to check — the free-form fields are validated here instead. */
  private sanitize(body: unknown, defaultRunnerId?: string): OrchestratorWorkspaceInput {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('workspace body must be an object');
    }
    const input = body as Record<string, unknown>;
    const name = this.optionalString(input, 'name');
    if (name !== undefined && name.length === 0) {
      throw new BadRequestException('name cannot be empty');
    }
    if (input.enableWorktree !== undefined && typeof input.enableWorktree !== 'boolean') {
      throw new BadRequestException('enableWorktree must be a boolean');
    }
    return {
      name,
      description: this.optionalString(input, 'description'),
      provider: this.optionalString(input, 'provider'),
      systemPrompt: this.optionalString(input, 'systemPrompt'),
      appendSystemPrompt: this.optionalString(input, 'appendSystemPrompt'),
      workDir: this.optionalString(input, 'workDir'),
      runnerId: this.optionalString(input, 'runnerId') ?? defaultRunnerId,
      enableWorktree: input.enableWorktree as boolean | undefined,
      env: this.normalizeEnv(input.env),
      defaultMergeTarget: this.optionalString(input, 'defaultMergeTarget'),
    };
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
