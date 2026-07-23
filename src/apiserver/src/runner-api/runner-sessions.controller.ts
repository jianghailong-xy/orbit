import {
  BadRequestException,
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
  constructor(private readonly sessions: SessionsService) {}

  @Post('sessions')
  createSession(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') parentSessionId: string | undefined,
    @Body() dto: { prompt: string; agentId?: string; title?: string; model?: string },
  ) {
    if (!parentSessionId) throw new BadRequestException('missing parent session context');
    return this.sessions.spawnFromSession(runner.ownerId, parentSessionId, dto);
  }

  @Get('sessions')
  listSessions(
    @CurrentRunner() runner: Runner,
    @Query('status') status: string | undefined,
    @Query('parentSessionId') parentSessionId: string | undefined,
  ) {
    // Ignore an unknown status rather than letting Prisma 500 on a bad enum value.
    const s =
      status && (Object.values(RunStatus) as string[]).includes(status) ? (status as RunStatus) : undefined;
    return this.sessions.listForOrchestration(runner.ownerId, { status: s, parentSessionId });
  }

  @Get('sessions/:id')
  getSession(@CurrentRunner() runner: Runner, @Param('id') id: string) {
    return this.sessions.get(runner.ownerId, id);
  }

  @Post('sessions/:id/turns')
  sendMessage(
    @CurrentRunner() runner: Runner,
    @Param('id') id: string,
    @Body() dto: { message: string },
  ) {
    return this.sessions.createTurn(runner.ownerId, id, {
      clientTurnId: randomUUID(),
      content: dto.message,
    });
  }

  @Post('sessions/:id/interrupt')
  interruptSession(@CurrentRunner() runner: Runner, @Param('id') id: string) {
    return this.sessions.interrupt(runner.ownerId, id);
  }
}
