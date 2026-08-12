import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { randomUUID } from 'crypto';
import { Runner, RunStatus } from '@prisma/client';
import { RunnerSessionScope, SessionsService } from '../sessions/sessions.service';
import { CurrentRunner } from './current-runner.decorator';
import { CurrentServiceGrant, RunnerSessionAuthGuard } from './runner-session-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { ServiceTokenGrant, ServiceTokenScope } from './service-token.authorizer';

/** No calling session => the request comes from a headless process, not from an agent. */
function isHeadlessCaller(callingSessionId: string | undefined): boolean {
  return !callingSessionId?.trim();
}

/**
 * What the machine's own runner credential grants a headless caller: observe and message the
 * sessions this runner already hosts. Not creation — starting new work is the one headless verb
 * that must come from a credential someone minted on purpose and can revoke on its own.
 */
const RUNNER_CREDENTIAL_SCOPES: readonly ServiceTokenScope[] = [
  'session:get',
  'session:list',
  'session:send',
];

/**
 * Session orchestration (L3) for in-session agents, reached by the `orbit mcp` server with the
 * machine's runner token. Tenant scope is the runner's owner; a spawn is attributed to the
 * PARENT session (X-Orbit-Session-Id, injected by the runner) whose agent must have
 * orchestration enabled — SessionsService enforces that plus the depth/child-count guards.
 *
 * A caller with no X-Orbit-Session-Id at all is HEADLESS: a launchd/cron bridge that belongs to
 * no session and outlives every session, so it can hold no session-bound credential. What it may
 * do depends on which credential it presents:
 *   - the machine's runner token   → get / list / send over the sessions this runner hosts
 *   - a minted service token       → exactly its scopes (which may include create), further
 *                                    narrowed to one agent when the token is pinned
 * Either way the destructive verbs — interrupt, merge, end, complete — and the owner-wide search
 * stay out of reach: those still require a live calling session with orchestration enabled.
 *
 * Registered AFTER RunnerApiController (see runner-api.module.ts) so its static
 * GET sessions/claim | sessions/reclaim routes win over this controller's GET sessions/:id.
 */
@UseGuards(RunnerSessionAuthGuard)
@Controller('runner')
export class RunnerSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
  ) {}

  /**
   * Resolve one headless request's reach, then assert it covers what the route needs.
   *
   * A service token authenticates a process, never a session, so presenting one alongside a
   * calling session is refused outright rather than silently resolved one way or the other.
   */
  private headlessScope(
    runner: Runner,
    grant: ServiceTokenGrant | undefined,
    scope: ServiceTokenScope,
  ): RunnerSessionScope {
    const granted = grant ? grant.scopes : RUNNER_CREDENTIAL_SCOPES;
    if (!granted.includes(scope)) {
      throw new ForbiddenException(
        grant
          ? `this service token does not have the ${scope} scope`
          : `${scope} requires a service token; mint one with \`orbit token mint\``,
      );
    }
    return { assignedRunnerId: runner.id, agentId: grant?.agentId ?? null };
  }

  private assertNoServiceToken(grant: ServiceTokenGrant | undefined): void {
    if (grant) {
      throw new ForbiddenException('a service token cannot act on behalf of a session');
    }
  }

  @Post('sessions')
  async createSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') parentSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    // Inline type — nothing validates it, and `agentId` is exactly what a model copies out of an
    // Orbit URL when told to "run this under that agent".
    @Body(PublicIdPipe.forFields('agentId'))
    dto: {
      prompt: string;
      agentId?: string;
      agentName?: string;
      title?: string;
      model?: string;
      provider?: string;
    },
  ) {
    if (isHeadlessCaller(parentSessionId)) {
      const scope = this.headlessScope(runner, grant, 'session:create');
      // The pin is the authorization, so it is also the target: a caller cannot redirect the
      // spawn at another agent by passing one in the body.
      if (dto.agentId && dto.agentId !== scope.agentId) {
        throw new ForbiddenException('this service token may only start its own agent');
      }
      if (!scope.agentId) throw new ForbiddenException('this service token has no agent to start');
      return this.sessions.spawnForServiceToken(
        runner.ownerId,
        { assignedRunnerId: runner.id, agentId: scope.agentId, tokenId: grant!.tokenId },
        { prompt: dto.prompt, title: dto.title, model: dto.model },
      );
    }
    this.assertNoServiceToken(grant);
    const caller = await this.orchestration.assert(runner, parentSessionId, orchestrationToken);
    return this.sessions.spawnFromSession(runner.ownerId, caller, dto);
  }

  @Get('sessions')
  async listSessions(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Query('status') status: string | undefined,
    @Query('parentSessionId', PublicIdPipe) parentSessionId: string | undefined,
  ) {
    // Ignore an unknown status rather than letting Prisma 500 on a bad enum value.
    const s =
      status && (Object.values(RunStatus) as string[]).includes(status) ? (status as RunStatus) : undefined;
    if (isHeadlessCaller(callingSessionId)) {
      return this.sessions.listForOrchestration(runner.ownerId, {
        status: s,
        parentSessionId,
        scope: this.headlessScope(runner, grant, 'session:list'),
      });
    }
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.listForOrchestration(runner.ownerId, { status: s, parentSessionId });
  }

  // Same cross-scope search the clients' ⌘K palette runs (SessionsService.search), scoped to the
  // runner's owner. MUST stay above `sessions/:id` — Nest matches in declaration order, so below
  // it the literal path would be swallowed as an id.
  @Get('sessions/search')
  async searchSessions(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Query('q') q: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    // Deliberately no headless path: search spans every scope the OWNER has, including
    // conversation text from sessions on other machines, which is exactly what a machine-local
    // credential must not reach.
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.search(runner.ownerId, q, Number(limit) || 20);
  }

  @Get('sessions/:id')
  async getSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    if (isHeadlessCaller(callingSessionId)) {
      return this.sessions.getForOrchestration(
        runner.ownerId,
        id,
        this.headlessScope(runner, grant, 'session:get'),
      );
    }
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.getForOrchestration(runner.ownerId, id);
  }

  @Post('sessions/:id/turns')
  async sendMessage(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: { message: string },
  ) {
    if (isHeadlessCaller(callingSessionId)) {
      await this.sessions.assertHostedByRunner(
        runner.ownerId,
        this.headlessScope(runner, grant, 'session:send'),
        id,
      );
    } else {
      this.assertNoServiceToken(grant);
      await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    }
    return this.sessions.createTurn(runner.ownerId, id, {
      clientTurnId: randomUUID(),
      content: dto.message,
    });
  }

  // The four lifecycle verbs below have NO headless path by design. They are the most damaging
  // thing a machine-local credential could reach and a bridge never needs them, so they are not
  // in the service-token vocabulary at all: every one of them still requires a live calling
  // session whose agent has orchestration enabled.
  @Post('sessions/:id/interrupt')
  async interruptSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.interrupt(runner.ownerId, id);
  }

  @Post('sessions/:id/merge')
  async mergeSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: { targetBranch?: string },
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.mergeToMain(runner.ownerId, id, dto.targetBranch);
  }

  @Post('sessions/:id/end')
  async endSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.end(runner.ownerId, id);
  }

  // The runner's own POST sessions/:id/finalize route is reserved for reporting process
  // teardown. Orchestrators use /complete-session for the user-facing Complete action:
  // it ends a live session with reason=completed and moves it out of Open.
  @Post('sessions/:id/complete-session')
  async completeSession(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    this.assertNoServiceToken(grant);
    await this.orchestration.assert(runner, callingSessionId, orchestrationToken);
    return this.sessions.complete(runner.ownerId, id);
  }

  /** @deprecated Compatibility route for older runner binaries. */
  @Post('sessions/:id/archive')
  async archiveSessionCompatibility(
    @CurrentRunner() runner: Runner,
    @CurrentServiceGrant() grant: ServiceTokenGrant | undefined,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.completeSession(runner, grant, callingSessionId, orchestrationToken, id);
  }
}
