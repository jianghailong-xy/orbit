import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiMaintenanceFinishDto, WikiProposeDto, WikiVerificationReportDto } from '../wiki/dto';
import { isWikiMaintenanceSession, WikiMaintenance } from '../wiki/wiki-maintenance';
import { finishWikiMaintenanceRun, wikiMaintenanceCheck, wikiMaintenanceRunContext } from '../wiki/wiki-maintenance-run';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import { answerFor, answerForVerifications, WikiRefusalError, WikiService, type WikiPrincipal } from '../wiki/wiki.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The runner door's routes of the Wiki maintenance job (contracts/wiki.contract.json `maintenance.job`,
 * criterion 3): what `orbit wiki maintain` starts from, how it proposes as the space's maintenance run,
 * how it verifies what ended sessions left waiting, how it ends, and what `orbit wiki check` asks.
 *
 * ALL BUT THE CHECK ARE A MAINTENANCE RUN'S ALONE, as the dossiers and the cursor are: the calling
 * session must be a maintenance run of the space in the path (`isWikiMaintenanceSession`) — a headless
 * call is refused 400, any other session of the owner WIKI_NOT_MAINTENANCE_SESSION, another owner's space
 * a plain 404. What it proposes through this door is recorded with origin `maintenance`, which the effect
 * policy, the review queue's quotas and the circuit breaker read, and nothing the session sends can make
 * it anything else. What it verifies through this door is what no proposer is left to verify: the ops
 * ended sessions left waiting in the space (contract `reviewModes.verification.adoption`).
 *
 * THE CHECK IS ALSO THE RUNNER'S OWN. A task's acceptance command runs after the session's turn, in a
 * shell the runner starts with no session context, so the check answers a headless call of the space's
 * owner's runner — it reads the cursor and the run's row and writes nothing. A call that names a session
 * is held to the same test as the other routes.
 *
 * A controller of its own, beside `RunnerWikiMaintenanceController`, so the specs that stand that one up
 * by hand construct it as they always have.
 */
@UseGuards(RunnerAuthGuard, WikiRolloutGuard)
@Controller('runner/wiki')
export class RunnerWikiMaintainController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wiki: WikiService,
    private readonly maintenance: WikiMaintenance,
  ) {}

  /** Where the run starts (contract `maintenance.job.context`), recorded as started by this session. */
  @Get('spaces/:id/maintenance/run')
  async run(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    const sessionId = await this.maintainer(runner, callingSessionId, id, true);
    return wikiMaintenanceRunContext(this.prisma, runner.ownerId, id, sessionId!);
  }

  /** The run's proposals, as the space's maintenance run (origin `maintenance`); `dryRun` records nothing. */
  @Post('spaces/:id/maintenance/changesets')
  @HttpCode(HttpStatus.OK)
  async propose(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiProposeDto,
  ) {
    const sessionId = await this.maintainer(runner, callingSessionId, id, true);
    const principal: WikiPrincipal = { origin: 'maintenance', ownerId: runner.ownerId, userId: null, sessionId: sessionId!, toolCallId: null };
    return answerFor(await this.wiki.submitChangeset(principal, id, dto));
  }

  /**
   * What ended sessions left waiting for their verification in the space (contract
   * `reviewModes.verification.adoption`), a page at a time as the proposer's own list is: the run adopts
   * them, since nobody who proposed them is left to verify them.
   */
  @Get('spaces/:id/maintenance/verifications')
  async adoptions(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    /** The last opId of the page before, to read the next one. */
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    const sessionId = await this.maintainer(runner, callingSessionId, id, true);
    const principal: WikiPrincipal = { origin: 'maintenance', ownerId: runner.ownerId, userId: null, sessionId: sessionId!, toolCallId: null };
    return this.wiki.listVerifications(principal, id, {
      after: after?.trim() || null,
      limit: limit === undefined ? undefined : Number(limit),
      adopt: true,
    });
  }

  /** Verdicts for what the run adopted, each recorded and applied as a proposer's own verdict is. */
  @Post('spaces/:id/maintenance/verifications')
  @HttpCode(HttpStatus.OK)
  async adopt(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiVerificationReportDto,
  ) {
    const sessionId = await this.maintainer(runner, callingSessionId, id, true);
    const principal: WikiPrincipal = { origin: 'maintenance', ownerId: runner.ownerId, userId: null, sessionId: sessionId!, toolCallId: null };
    return answerForVerifications(await this.wiki.recordVerifications(principal, id, dto.verdicts, { adopt: true }));
  }

  /** How the run ended (contract `maintenance.job.finish`): the cursor advanced as its route rules, and the report kept. */
  @Post('spaces/:id/maintenance/finish')
  @HttpCode(HttpStatus.OK)
  async finish(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiMaintenanceFinishDto,
  ) {
    const sessionId = await this.maintainer(runner, callingSessionId, id, true);
    return finishWikiMaintenanceRun(this.prisma, this.maintenance, runner.ownerId, id, sessionId!, {
      to: dto.to ?? null,
      outcome: dto.outcome,
      error: dto.error ?? null,
      failureKind: dto.failureKind ?? null,
      report: dto.report ?? null,
    });
  }

  /** `orbit wiki check` (contract `maintenance.job.check`): the cursor against the position a task expects. */
  @Get('spaces/:id/maintenance/check')
  async check(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Query('expect') expect?: string,
  ) {
    await this.maintainer(runner, callingSessionId, id, false);
    if (!expect?.trim()) {
      throw new BadRequestException('expect is required: the cursor token the maintenance task was made with (--expect-cursor)');
    }
    return wikiMaintenanceCheck(this.prisma, runner.ownerId, id, expect.trim());
  }

  /**
   * The calling session when it is a maintenance run of this space; null for a headless call where one is
   * allowed. Every other caller is refused before anything of the space is read.
   */
  private async maintainer(
    runner: Pick<Runner, 'id' | 'ownerId'>,
    header: string | undefined,
    spaceId: string,
    sessionRequired: boolean,
  ): Promise<string | null> {
    const named = header?.trim();
    if (!named) {
      if (sessionRequired) {
        throw new BadRequestException(
          'missing session context: only a Wiki maintenance run of this space starts, proposes, verifies or ends a run, so this door needs X-Orbit-Session-Id',
        );
      }
      await this.wiki.requireSpace(runner.ownerId, spaceId);
      return null;
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
    await this.wiki.requireSpace(runner.ownerId, spaceId);
    if (!(await isWikiMaintenanceSession(this.prisma, { ownerId: runner.ownerId, sessionId, spaceId }))) {
      throw new WikiRefusalError({
        code: 'WIKI_NOT_MAINTENANCE_SESSION',
        message:
          "only a Wiki maintenance run of this space starts, proposes to, verifies for or ends a maintenance run: a session whose task is in the space's hidden «Wiki maintenance» list. This session is not one.",
      });
    }
    return sessionId;
  }
}
