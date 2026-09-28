import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiCursorAdvanceDto } from '../wiki/dto';
import { isWikiMaintenanceSession, WikiMaintenance } from '../wiki/wiki-maintenance';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import { WikiRefusalError, WikiService } from '../wiki/wiki.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The runner door's maintenance routes (design §5.1, contracts/wiki.contract.json
 * `agentSurface.doors.runner.maintenanceRoutes` and `maintenance`): what a Wiki maintenance run reads
 * — its space's dossiers — and how it says it is done — the cursor.
 *
 * ONLY A MAINTENANCE SESSION OF THE SPACE. The calling session (`X-Orbit-Session-Id`, a session this
 * runner hosts for its owner, checked the way the other runner routes check it) must be a maintenance
 * run of the space named in the path — its task in that space's maintenance list
 * (`isWikiMaintenanceSession`). A headless call is refused 400, any other session of the owner
 * WIKI_NOT_MAINTENANCE_SESSION, and a space of another owner is the plain 404 every tenancy check
 * answers: a dossier is conversation text cut from the owner's sessions, and nothing else reads it.
 *
 * A controller of its own, beside `RunnerWikiController` rather than inside it, so that the specs which
 * stand that controller up by hand construct it as they always have: nothing it injects changed.
 */
@UseGuards(RunnerAuthGuard, WikiRolloutGuard)
@Controller('runner/wiki')
export class RunnerWikiMaintenanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wiki: WikiService,
    private readonly maintenance: WikiMaintenance,
  ) {}

  /**
   * One page of dossiers (contract `maintenance.dossier`): the facts after the later of `after` and the
   * watermark, a dossier for each session they name, and the token to advance to once they are done.
   */
  @Get('spaces/:id/dossiers')
  async dossiers(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    /** A cursor token a page handed out; left out, the page starts at the watermark. */
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    await this.maintainer(runner, callingSessionId, id);
    const asked = limit === undefined ? undefined : Number(limit);
    if (asked !== undefined && (!Number.isInteger(asked) || asked < 1)) {
      throw new BadRequestException('limit must be a whole number of sessions, 1 or more');
    }
    return this.maintenance.dossierPage(runner.ownerId, id, { after: after?.trim() || null, limit: asked });
  }

  /**
   * How the run ended (contract `maintenance.cursor.advance`): a succeeded run moves the cursor to the
   * token, forward only; a failed or truncated one moves nothing and is counted.
   */
  @Post('spaces/:id/cursor')
  @HttpCode(HttpStatus.OK)
  async advance(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiCursorAdvanceDto,
  ) {
    await this.maintainer(runner, callingSessionId, id);
    return this.maintenance.advanceCursor(runner.ownerId, id, {
      to: dto.to ?? '',
      outcome: dto.outcome,
      error: dto.error ?? null,
    });
  }

  /**
   * The calling session, when it is a maintenance run of this space; every other caller is refused
   * before anything of the space is read.
   */
  private async maintainer(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined, spaceId: string): Promise<string> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException(
        'missing session context: only a Wiki maintenance run of this space reads its dossiers or moves its cursor, so this door needs X-Orbit-Session-Id',
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
          'only a Wiki maintenance run of this space reads its dossiers or moves its cursor: a session whose task is in the '
            + "space's hidden «Wiki maintenance» list. This session is not one.",
      });
    }
    return sessionId;
  }
}
