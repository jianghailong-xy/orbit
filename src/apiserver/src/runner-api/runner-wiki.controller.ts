import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { JUDGMENT_DISPATCH_ORIGIN } from '../projects/coordinator-authority';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiProposeDto, WikiVerificationReportDto } from '../wiki/dto';
import { registerWikiNote, wikiImportPrincipal, WikiNoteDto } from '../wiki/wiki-import';
import { createWikiImportJob, readWikiImportJob, wikiImportExecutor, WikiImportJobDto } from '../wiki/wiki-import-jobs';
import { currentWikiExecutorSwitch, wikiExecutorServes } from '../wiki/wiki-executor-switch';
import { flagParam, listParam, WikiRetrieval } from '../wiki/wiki-retrieval';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import { answerFor, answerForVerifications, WikiService, WikiRefusalError, type WikiPrincipal } from '../wiki/wiki.service';
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
 * only, and a session that could reach it would be a session deciding what the owner keeps. What it
 * does have is the verification's two routes, and they are no decide: they carry a model's verdict on
 * the calling session's OWN proposals in an Automatic space, the one mode the owner set up to let a
 * verifier decide (contract `reviewModes.verification`), and nothing of anybody else's.
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

  /**
   * The ops this session proposed that wait for their verification in the space (contract
   * `reviewModes.verification.list`): what `orbit wiki verify` hands its verifier, one page at a time.
   *
   * THE PROPOSER'S OWN, AND ONLY WITH A SESSION. A verdict is reported by the session that proposed
   * the op and by no other, so a headless call — no session to be the proposer — is refused, and a
   * session sees its own ops alone: another session's, and another owner's space, are not there.
   */
  @Get('spaces/:id/verifications')
  async verifications(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    /** The last opId of the page before, to read the next one. */
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    const principal = await this.proposer(runner, callingSessionId);
    return this.wiki.listVerifications(principal, id, {
      after: after?.trim() || null,
      limit: limit === undefined ? undefined : Number(limit),
    });
  }

  /**
   * Report verdicts for ops this session proposed (contract `reviewModes.verification.report`): each
   * is recorded with its trail and applied as it says, on its own, and the answer carries every
   * verdict's outcome. A request none of whose verdicts was recorded answers with the status of its
   * first refusal — 404 for an op that is not this session's to report.
   */
  @Post('spaces/:id/verifications')
  @HttpCode(HttpStatus.OK)
  async verify(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiVerificationReportDto,
  ) {
    const principal = await this.proposer(runner, callingSessionId);
    return answerForVerifications(await this.wiki.recordVerifications(principal, id, dto.verdicts));
  }

  /**
   * `orbit wiki import`, first step (contract `import.note`): one file registered as the `note` its
   * entries will cite — redacted before it is hashed or kept, and the note the space already holds when
   * the text is one it has. The answer carries the stored text, which is what the importer's model reads.
   *
   * WHEN THE SERVER READS (contract `import.server`), the text is the server's to hand to its own model and
   * no session's: a runner that says the server reads it (`readBy: server`) is answered without it, and one
   * that does not — an `orbit wiki import` that predates the server's import, and would read the text with
   * the session's own provider — is refused WIKI_SERVER_EXECUTES before anything is registered.
   */
  @Post('spaces/:id/notes')
  @HttpCode(HttpStatus.OK)
  async registerNote(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiNoteDto,
  ) {
    await this.importer(runner, callingSessionId);
    if (!wikiExecutorServes(currentWikiExecutorSwitch(), runner.ownerId)) {
      return registerWikiNote(this.prisma, this.wiki, runner.ownerId, id, dto);
    }
    if (dto.readBy !== 'server') {
      throw serverExecutes('this account\'s wiki import runs on the Orbit server (ORBIT_WIKI_EXECUTOR): the server reads '
        + 'each note with its System model, and this orbit wiki import predates that — it would read the note with the '
        + 'session\'s own model. Nothing was registered or read: upgrade the runner, then run the import again.');
    }
    const { text: _text, ...registered } = await registerWikiNote(this.prisma, this.wiki, runner.ownerId, id, dto);
    return registered;
  }

  /**
   * `orbit wiki import`, second step (contract `import.propose`): wiki_propose's body, recorded with
   * origin `import` into the space the path names — and taking effect exactly as that space's review
   * mode takes an agent's proposal, floors and all.
   */
  @Post('spaces/:id/imports')
  @HttpCode(HttpStatus.OK)
  async proposeImport(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiProposeDto,
  ) {
    const principal = await this.importer(runner, callingSessionId);
    if (wikiExecutorServes(currentWikiExecutorSwitch(), runner.ownerId)) {
      // What a session's own model found is not what the server's import proposes (contract `import.server`).
      throw serverExecutes('this account\'s wiki import runs on the Orbit server (ORBIT_WIKI_EXECUTOR): its import job '
        + 'proposes what the System model found, and the door takes no entries a session\'s own model wrote. Nothing '
        + 'was proposed: upgrade the runner, then run the import again.');
    }
    return answerFor(await this.wiki.submitChangeset(principal, id, dto));
  }

  /**
   * `orbit wiki import`, before it reads anything (contract `import.server.executor`): which path this space's
   * import takes — the server's import job, when the executor switch gives the account to the server, or the
   * session's own model as it always has — and the System model the server would read with.
   */
  @Get('spaces/:id/import')
  async importExecutor(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    await this.importer(runner, callingSessionId);
    await this.wiki.requireSpace(runner.ownerId, id);
    return wikiImportExecutor(this.prisma, runner.ownerId);
  }

  /**
   * `orbit wiki import` on the server (contract `import.server.create`): the notes the command registered, as
   * one import job of the space, recorded against the calling session. The command names the job's id, so the
   * same request sent again after a lost answer is answered with the job it already made.
   */
  @Post('spaces/:id/import-jobs')
  @HttpCode(HttpStatus.OK)
  async createImportJob(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiImportJobDto,
  ) {
    const principal = await this.importer(runner, callingSessionId);
    return createWikiImportJob(this.prisma, this.wiki, {
      ownerId: runner.ownerId,
      spaceId: id,
      sessionId: principal.sessionId as string,
      body: dto,
    });
  }

  /** The import job the command waits on (contract `import.server.read`): where it is, and its report. */
  @Get('spaces/:id/import-jobs/:jobId')
  async readImportJob(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('jobId', PublicIdPipe) jobId: string,
  ) {
    await this.importer(runner, callingSessionId);
    return readWikiImportJob(this.prisma, { ownerId: runner.ownerId, spaceId: id, jobId });
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
   * The caller of a verification route: the session this runner hosts that proposed the ops, which
   * the header must name (contract `agentSurface.doors.runner.verificationNote`).
   */
  private async proposer(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<WikiPrincipal> {
    const sessionId = await this.callingSession(runner, header);
    if (!sessionId) {
      throw new BadRequestException(
        'missing session context: a verdict is reported by the session that proposed the op, so this door needs X-Orbit-Session-Id',
      );
    }
    await this.assertNotExcluded(sessionId);
    return { origin: 'agent', ownerId: runner.ownerId, userId: null, sessionId, toolCallId: null };
  }

  /**
   * The caller of an import route: a session this runner hosts (contract `import.note.who`), whose
   * changesets the import's ops are recorded on — so the ones an automatic space holds back are that
   * session's to verify.
   */
  private async importer(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<WikiPrincipal> {
    const sessionId = await this.callingSession(runner, header);
    if (!sessionId) {
      throw new BadRequestException(
        'missing session context: an import is recorded against the session that runs it, so this door needs X-Orbit-Session-Id',
      );
    }
    await this.assertNotExcluded(sessionId);
    return wikiImportPrincipal(runner.ownerId, sessionId);
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

/** The refusal a runner door route answers when the account's pipeline is the server's (contract `refusals`). */
function serverExecutes(message: string): WikiRefusalError {
  return new WikiRefusalError({ code: 'WIKI_SERVER_EXECUTES', message });
}
