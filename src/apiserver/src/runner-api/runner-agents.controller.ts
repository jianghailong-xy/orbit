import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PermissionMode } from '@orbit/shared';
import { AgentsService } from '../agents/agents.service';
import { CreateAgentDto, UpdateAgentDto } from '../agents/dto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

// Fields an in-session orchestrator may set on an agent. Deliberately EXCLUDES
// enableOrchestration (and enabled): the orchestration permission is human-granted in the web
// UI only — an agent must never be able to grant it to itself or another agent (privilege
// escalation). Anything not listed here is dropped by `sanitize` before hitting the service.
type OrchestratorAgentInput = {
  name?: string;
  description?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  workDir?: string;
  runnerId?: string;
  enableWorktree?: boolean;
  env?: unknown;
  permissionMode?: string;
  defaultMergeTarget?: string;
};

const PERMISSION_MODES: string[] = Object.values(PermissionMode);

/**
 * Agent management for in-session orchestrators, reached by the `orbit mcp` server with the
 * machine's runner token. Tenant scope is the runner's owner. Gated on the CALLING session
 * (X-Orbit-Session-Id) having an orchestration-enabled agent — the same guard as session_create —
 * so a non-orchestrator agent, or a direct token call without an orchestrating session, is refused.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerAgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get('agents')
  async listAgents(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
  ) {
    await this.assertOrchestrator(runner.ownerId, sessionId);
    return this.agents.list(runner.ownerId);
  }

  @Post('agents')
  async createAgent(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() body: OrchestratorAgentInput,
  ) {
    await this.assertOrchestrator(runner.ownerId, sessionId);
    if (!body.name) throw new BadRequestException('name is required');
    // Bind to the calling runner by default so the new agent can actually run sessions.
    const agent = await this.agents.create(
      runner.ownerId,
      this.sanitize(body, runner.id) as CreateAgentDto,
    );
    // Push it to the owner's control-plane stream so their agent list shows it live instead of
    // only after a manual reload — the agent-side mirror of TasksService's publishTaskChanged.
    // Scoped via the calling session (assertOrchestrator already proved it's this owner's).
    this.realtime.publishAgentChanged(sessionId!, agent.id);
    return agent;
  }

  @Patch('agents/:id')
  async updateAgent(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Param('id') id: string,
    @Body() body: OrchestratorAgentInput,
  ) {
    await this.assertOrchestrator(runner.ownerId, sessionId);
    const agent = await this.agents.update(
      runner.ownerId,
      id,
      this.sanitize(body) as UpdateAgentDto,
    );
    this.realtime.publishAgentChanged(sessionId!, id);
    return agent;
  }

  /** Whitelist the caller's fields (drops enableOrchestration/enabled etc. an agent must not
   *  control). On create, default runnerId to the calling runner so the agent can run.
   *  This body is a plain type, not a DTO class, so the global ValidationPipe has no metatype
   *  to check — the free-form fields are validated here instead. */
  private sanitize(body: OrchestratorAgentInput, defaultRunnerId?: string) {
    if (body.permissionMode !== undefined && !PERMISSION_MODES.includes(body.permissionMode)) {
      throw new BadRequestException(`permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`);
    }
    return {
      name: body.name,
      description: body.description,
      provider: body.provider,
      model: body.model,
      systemPrompt: body.systemPrompt,
      appendSystemPrompt: body.appendSystemPrompt,
      workDir: body.workDir,
      runnerId: body.runnerId ?? defaultRunnerId,
      enableWorktree: body.enableWorktree,
      env: this.normalizeEnv(body.env),
      permissionMode: body.permissionMode,
      defaultMergeTarget: body.defaultMergeTarget,
    };
  }

  /** The runner decodes `env` into a map[string]string, so a nested/non-string value would
   *  break every subsequent claim for that agent. Reject it at the write instead. */
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

  /** The calling session's agent must have orchestration enabled (mirrors session_create). */
  private async assertOrchestrator(ownerId: string, sessionId: string | undefined): Promise<void> {
    if (!sessionId) throw new BadRequestException('missing session context');
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { agent: { select: { enableOrchestration: true } } },
    });
    if (!session?.agent?.enableOrchestration) {
      throw new ForbiddenException('orchestration is not enabled for this agent');
    }
  }
}
