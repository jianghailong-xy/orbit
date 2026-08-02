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
import { Agent, Runner } from '@prisma/client';
import { PermissionMode } from '@orbit/shared';
import { AgentsService } from '../agents/agents.service';
import { CreateAgentDto, UpdateAgentDto } from '../agents/dto';
import { RealtimeService } from '../realtime/realtime.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

// Fields an in-session orchestrator may set on an agent. Deliberately EXCLUDES
// enableOrchestration (and enabled): the orchestration permission is human-granted in the web
// UI only — an agent must never be able to grant it to itself or another agent (privilege
// escalation). Anything not listed here is dropped by `sanitize` before hitting the service.
type OrchestratorAgentInput = {
  name?: string;
  description?: string;
  provider?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  workDir?: string;
  runnerId?: string;
  enableWorktree?: boolean;
  env?: unknown;
  permissionMode?: string;
  defaultMergeTarget?: string;
};

type OrchestratorAgentRecord = Pick<
  Agent,
  | 'id'
  | 'name'
  | 'description'
  | 'provider'
  | 'workDir'
  | 'runnerId'
  | 'enableWorktree'
  | 'permissionMode'
  | 'defaultMergeTarget'
> & {
  runner?: { id: string; name: string; displayName: string | null } | null;
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
    private readonly orchestration: RunnerOrchestrationAuthorizer,
    private readonly realtime: RealtimeService,
  ) {}

  @Get('agents')
  async listAgents(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
  ) {
    await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const agents = await this.agents.list(runner.ownerId);
    return agents.map((agent) => this.toOrchestrationView(agent));
  }

  @Post('agents')
  async createAgent(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Body() body: unknown,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const sanitized = this.sanitize(body, runner.id);
    if (!sanitized.name) throw new BadRequestException('name is required');
    // Bind to the calling runner by default so the new agent can actually run sessions.
    const agent = await this.agents.create(
      runner.ownerId,
      sanitized as CreateAgentDto,
    );
    // Push it to the owner's control-plane stream so their agent list shows it live instead of
    // only after a manual reload — the agent-side mirror of TasksService's publishTaskChanged.
    // Scoped via the calling session, which assertOrchestrator returned as this owner's.
    this.realtime.publishAgentChanged(scope, agent.id);
    return this.toOrchestrationView(agent);
  }

  @Patch('agents/:id')
  async updateAgent(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const scope = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const agent = await this.agents.update(
      runner.ownerId,
      id,
      this.sanitize(body) as UpdateAgentDto,
    );
    this.realtime.publishAgentChanged(scope, id);
    return this.toOrchestrationView(agent);
  }

  /** Never expose engine credentials or policy prompts to the model invoking MCP. */
  private toOrchestrationView(agent: OrchestratorAgentRecord) {
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      provider: agent.provider,
      workDir: agent.workDir,
      runnerId: agent.runnerId,
      enableWorktree: agent.enableWorktree,
      permissionMode: agent.permissionMode,
      defaultMergeTarget: agent.defaultMergeTarget,
      ...(agent.runner
        ? {
            runner: {
              id: agent.runner.id,
              name: agent.runner.name,
              displayName: agent.runner.displayName,
            },
          }
        : {}),
    };
  }

  /** Whitelist the caller's fields (drops enableOrchestration/enabled etc. an agent must not
   *  control). On create, default runnerId to the calling runner so the agent can run.
   *  This body is a plain type, not a DTO class, so the global ValidationPipe has no metatype
   *  to check — the free-form fields are validated here instead. */
  private sanitize(body: unknown, defaultRunnerId?: string): OrchestratorAgentInput {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('agent body must be an object');
    }
    const input = body as Record<string, unknown>;
    const name = this.optionalString(input, 'name');
    if (name !== undefined && name.length === 0) {
      throw new BadRequestException('name cannot be empty');
    }
    const permissionMode = this.optionalString(input, 'permissionMode');
    if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) {
      throw new BadRequestException(`permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`);
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
      permissionMode,
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
}
