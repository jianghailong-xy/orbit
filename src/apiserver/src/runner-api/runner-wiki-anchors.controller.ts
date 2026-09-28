import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpException, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid, type WikiAnchorReportResult } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiAnchorReportDto } from '../wiki/dto';
import { listWikiAnchors } from '../wiki/wiki-anchors';
import { isWikiMaintenanceSession } from '../wiki/wiki-maintenance';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import { WikiRefusalError, WikiService } from '../wiki/wiki.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The runner door's anchor re-verification (design §4.4, contracts/wiki.contract.json
 * `anchorRules.verify`, criterion 4): the git anchors a Wiki maintenance run re-verifies, and where it
 * reports what it found.
 *
 * ONLY A MAINTENANCE SESSION OF THE SPACE, as the dossier route and the cursor: the calling session
 * (`X-Orbit-Session-Id`, a session this runner hosts for its owner) must be a maintenance run of the
 * space named in the path — `isWikiMaintenanceSession`, the one test of it. A headless call is refused
 * 400, any other session of the owner WIKI_NOT_MAINTENANCE_SESSION, and another owner's space is the
 * plain 404 every tenancy check answers. What a check writes takes an entry out of the push and files a
 * challenge in the owner's Review, so no other session reports one.
 *
 * A controller of its own, beside the maintenance run's other routes rather than inside them, so that
 * the specs which stand those up by hand construct them as they always have.
 */
@UseGuards(RunnerAuthGuard, WikiRolloutGuard)
@Controller('runner/wiki')
export class RunnerWikiAnchorsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wiki: WikiService,
  ) {}

  /**
   * One page of the space's live entries that carry a git anchor (contract `anchorRules.verify.list`),
   * each at the revision a report must name, and the checkout the space's workspace names on this runner.
   */
  @Get('spaces/:id/anchors')
  async anchors(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    /** The `next` of the page before, to read the one after it. */
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    const sessionId = await this.maintainer(runner, callingSessionId, id);
    let from: string | null = null;
    if (after?.trim()) {
      try {
        from = toUuid(after.trim());
      } catch {
        throw new WikiRefusalError({
          code: 'WIKI_SCHEMA',
          message: 'after names no entry: hand back the next this list gave',
          errors: [{ path: 'after', message: 'names no entry' }],
        });
      }
    }
    const asked = limit === undefined ? null : Number(limit);
    if (asked !== null && (!Number.isInteger(asked) || asked < 1)) {
      throw new BadRequestException('limit must be a whole number of entries, 1 or more');
    }
    return listWikiAnchors(this.prisma, { ownerId: runner.ownerId, runnerId: runner.id, spaceId: id, sessionId, after: from, limit: asked });
  }

  /**
   * What the run found (contract `anchorRules.verify.report`): each entry recorded on its own, and the
   * answer carries every entry's outcome. A report none of whose entries was recorded or found stale
   * answers with the status of its first refusal.
   */
  @Post('spaces/:id/anchor-checks')
  @HttpCode(HttpStatus.OK)
  async report(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiAnchorReportDto,
  ) {
    const sessionId = await this.maintainer(runner, callingSessionId, id);
    return answerForAnchorChecks(await this.wiki.recordAnchorChecks({ ownerId: runner.ownerId, sessionId }, id, dto));
  }

  /**
   * The calling session, when it is a maintenance run of this space; every other caller is refused
   * before anything of the space is read.
   */
  private async maintainer(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined, spaceId: string): Promise<string> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException(
        'missing session context: only a Wiki maintenance run of this space re-verifies its anchors, so this door needs X-Orbit-Session-Id',
      );
    }
    let sessionId: string;
    try {
      sessionId = toUuid(named);
    } catch {
      throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    }
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId: runner.ownerId, assignedRunnerId: runner.id, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    // Another owner's space is a 404 before it is anything else (contract `refusalRules.notFound`).
    await this.wiki.requireSpace(runner.ownerId, spaceId);
    if (!(await isWikiMaintenanceSession(this.prisma, { ownerId: runner.ownerId, sessionId, spaceId }))) {
      throw new WikiRefusalError({
        code: 'WIKI_NOT_MAINTENANCE_SESSION',
        message:
          'only a Wiki maintenance run of this space re-verifies its anchors: a session whose task is in the '
            + "space's hidden «Wiki maintenance» list. This session is not one.",
      });
    }
    return sessionId;
  }
}

/**
 * The status a report is served with, on the rule a verification report's is: a report that recorded
 * an entry, or found one stale, is a 200, and one every entry of which was refused answers with the
 * status of its first refusal, every outcome in the body.
 */
function answerForAnchorChecks(result: WikiAnchorReportResult): WikiAnchorReportResult {
  const refused = result.outcomes.filter((outcome) => outcome.status === 'refused');
  if (result.outcomes.length > 0 && refused.length === result.outcomes.length) {
    const first = refused[0] as Extract<WikiAnchorReportResult['outcomes'][number], { status: 'refused' }>;
    throw new HttpException(result, first.httpStatus);
  }
  return result;
}
