import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { JUDGMENT_DISPATCH_ORIGIN } from '../projects/coordinator-authority';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiProposeDto } from '../wiki/dto';
import { flagParam, listParam, WikiRetrieval } from '../wiki/wiki-retrieval';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import { answerFor, WikiService, WikiRefusalError, type WikiPrincipal } from '../wiki/wiki.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The runner door: `/api/runner/wiki/*`, reached by `orbit mcp` and the `orbit wiki` CLI from inside a
 * session (design §5.1, contract `agentSurface.doors.runner`).
 *
 * THE CALLING SESSION IS THE ACTOR. `X-Orbit-Session-Id` is a session this runner hosts for its owner,
 * checked the way `runner-watches.controller.ts` checks it — never a body field, so nothing a model
 * writes can name another session. An agent's proposal is recorded against that session, its
 * workspace decides which space it is filed in, and it can never be decided from here.
 *
 * THERE IS NO DECIDE ON THIS DOOR, deliberately and not by omission: `decide` exists on the user door
 * only, and a session that could reach it would be a session deciding what the owner keeps.
 *
 * A HEADLESS CALL — no session header — is an agent with no session: it may still PROPOSE (contract
 * `changesetOrigins.agent`), and it must name the space, because it has no workspace for one to be
 * derived from. Reads need a session: what a session may read is what its bound workspace shares.
 *
 * NO SERVICE TOKEN. The guard is the machine's runner credential; a service token authenticates
 * nothing here (contract `refusalRules.serviceToken`), which is why this controller does not use
 * `RunnerSessionAuthGuard` the way the session routes do.
 *
 * NOT FOR AN ACCOUNT THE WIKI IS OFF FOR. Such a runner's owner is answered 404 WIKI_DISABLED on every
 * route here (ORBIT_WIKI, `wiki-rollout.ts`) — which a runner that knows the flag reports as the wiki
 * being off, and one that predates the wiki reads as the door not being there.
 */
@UseGuards(RunnerAuthGuard, WikiRolloutGuard)
@Controller('runner/wiki')
export class RunnerWikiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wiki: WikiService,
    private readonly retrieval: WikiRetrieval,
  ) {}

  /**
   * `wiki_search` (contract `agentSurface.toolSpecs`): entries only, each saying which legs found it.
   *
   * WHAT A SESSION SEES IS THE ROLE'S, NOT THIS REQUEST'S. It reads `active` entries of the space its
   * workspace is bound to — a pending proposal is visible only to the session that made it
   * (`readBoundary`), so this route takes no status parameter and the session's own proposals are
   * added by the retrieval behind it, never by a caller asking for them.
   *
   * `kind` (the tool spec's `kinds`, joined with commas), `topic`, `trust`, `paths` and `limit`
   * narrow within that boundary and cannot widen it: the space is resolved from the calling session,
   * and another codebase's entries are simply not in scope.
   */
  @Get('search')
  async search(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Query('q') q?: string,
    @Query('kind') kind?: string | string[],
    @Query('topic') topic?: string,
    @Query('trust') trust?: string | string[],
    @Query('paths') paths?: string | string[],
    @Query('limit') limit?: string,
    @Query('semantic') semantic?: string,
  ) {
    const sessionId = await this.callingSession(runner, callingSessionId);
    if (!sessionId) {
      throw new BadRequestException(
        'missing session context: what a session may read is what its bound workspace shares, so this door needs X-Orbit-Session-Id',
      );
    }
    await this.assertNotExcluded(sessionId);
    const spaceId = await this.wiki.resolveSpaceForCall(runner.ownerId, sessionId, null);
    return this.retrieval.search({
      ownerId: runner.ownerId,
      sessionId,
      spaceId,
      q,
      kinds: listParam(kind),
      topic: topic?.trim() || undefined,
      trust: listParam(trust),
      paths: listParam(paths),
      limit: limit === undefined ? undefined : Number(limit),
      semantic: flagParam(semantic),
    });
  }

  /**
   * Propose what this session learned: the one write an agent has (`wiki_propose`).
   *
   * The answer is per op — pending, applied, conflict or refused — and a request that recorded
   * something was accepted. `dryRun` checks the batch and records nothing.
   */
  @Post('changesets')
  @HttpCode(HttpStatus.OK)
  async propose(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Body() dto: WikiProposeDto,
  ) {
    const sessionId = await this.callingSession(runner, callingSessionId);
    if (sessionId) await this.assertNotExcluded(sessionId);
    const spaceId = await this.wiki.resolveSpaceForCall(runner.ownerId, sessionId, dto.spaceId ?? null);
    const principal: WikiPrincipal = {
      origin: 'agent',
      ownerId: runner.ownerId,
      userId: null,
      sessionId,
      toolCallId: null,
    };
    return answerFor(await this.wiki.submitChangeset(principal, spaceId, dto));
  }

  /** One entry, as the calling session's space shares it. */
  @Get('entries/:id')
  async getEntry(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    /** What the answer carries: nothing, or `sources` (the default) and `all` for its history too. */
    @Query('include') include?: string,
  ) {
    const sessionId = await this.callingSession(runner, callingSessionId);
    if (!sessionId) {
      throw new BadRequestException(
        'missing session context: what a session may read is what its bound workspace shares, so this door needs X-Orbit-Session-Id',
      );
    }
    await this.assertNotExcluded(sessionId);
    // Resolving the space FIRST is the read boundary: a session whose workspace is bound to no space
    // is told how to bind it rather than shown another codebase's entries.
    const spaceId = await this.wiki.resolveSpaceForCall(runner.ownerId, sessionId, null);
    return this.wiki.getEntry(
      runner.ownerId,
      id,
      { sources: include !== 'none', history: include === 'all', exposure: false },
      spaceId,
    );
  }

  /**
   * The calling session, when it is one this runner hosts for its owner; null when the call is headless.
   *
   * The same check `runner-watches.controller.ts` makes, with one difference that is the whole of
   * this door's shape: an absent header is not an error, it is a headless caller.
   */
  private async callingSession(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<string | null> {
    const named = header?.trim();
    if (!named) return null;
    let id: string;
    try {
      id = toUuid(named);
    } catch {
      throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    }
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: runner.ownerId, assignedRunnerId: runner.id, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    return session.id;
  }

  /**
   * Knowledge is not evidence (design §7.3, hard constraint): a session that verifies, forems or judges
   * work neither reads the wiki nor proposes to it, so it is refused WIKI_SESSION_EXCLUDED.
   */
  private async assertNotExcluded(sessionId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId },
      select: { dispatchOrigin: true, task: { select: { verifiesTaskId: true, isForeman: true } } },
    });
    const judging = session?.dispatchOrigin === JUDGMENT_DISPATCH_ORIGIN;
    const systemRun = session?.task?.isForeman === true || session?.task?.verifiesTaskId != null;
    if (judging || systemRun) {
      throw new WikiRefusalError({
        code: 'WIKI_SESSION_EXCLUDED',
        message:
          'this session verifies, forems or judges work, and knowledge is not evidence: such a session '
            + 'neither reads the wiki nor proposes to it.',
      });
    }
  }
}
