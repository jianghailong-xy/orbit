import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Runner, RunStatus } from '@prisma/client';
import { SessionsService } from '../sessions/sessions.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

/**
 * Session orchestration (L3) for in-session agents, reached by the `orbit mcp` server with the
 * machine's runner token. Tenant scope is the runner's owner; a spawn is attributed to the
 * PARENT session (X-Orbit-Session-Id, injected by the runner) whose agent must have
 * orchestration enabled — SessionsService enforces that plus the depth/child-count guards.
 *
 * Registered AFTER RunnerApiController (see runner-api.module.ts) so its static
 * GET sessions/claim | sessions/reclaim routes win over this controller's GET sessions/:id.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
  ) {}

  @Post('sessions')
  async createSession(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') parentSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Body() dto: { prompt: string; agentId?: string; agentName?: string; title?: string; model?: string },
  ) {
    const caller = await this.orchestration.assert(runner, parentSessionId, orchestrationToken);
    return this.sessions.spawnFromSession(runner.ownerId, caller, dto);
  }

  @Get('sessions')
  async listSessions(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Query('status') status: string | undefined,
    @Query('parentSessionId') parentSessionId: string | undefined,
  ) {
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    // Ignore an unknown status rather than letting Prisma 500 on a bad enum value.
    const s =
      status && (Object.values(RunStatus) as string[]).includes(status) ? (status as RunStatus) : undefined;
    return this.sessions.listForOrchestration(runner.ownerId, { status: s, parentSessionId });
  }

  // Same cross-scope search the clients' ⌘K palette runs (SessionsService.search), scoped to the
  // runner's owner. MUST stay above `sessions/:id` — Nest matches in declaration order, so below
  // it the literal path would be swallowed as an id.
  @Get('sessions/search')
  async searchSessions(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Query('q') q: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.search(runner.ownerId, q, Number(limit) || 20);
  }

  @Get('sessions/:id')
  async getSession(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id') id: string,
  ) {
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.getForOrchestration(runner.ownerId, id);
  }

  @Post('sessions/:id/turns')
  async sendMessage(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id') id: string,
    @Body() dto: { message: string },
  ) {
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.createTurn(runner.ownerId, id, {
      clientTurnId: randomUUID(),
      content: dto.message,
    });
  }

  @Post('sessions/:id/interrupt')
  async interruptSession(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id') id: string,
  ) {
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.interrupt(runner.ownerId, id);
  }

  @Post('sessions/:id/merge')
  async mergeSession(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id') id: string,
    @Body() dto: { targetBranch?: string },
  ) {
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.mergeToMain(runner.ownerId, id, dto.targetBranch);
  }

  @Post('sessions/:id/end')
  async endSession(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id') id: string,
  ) {
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.end(runner.ownerId, id);
  }
}
