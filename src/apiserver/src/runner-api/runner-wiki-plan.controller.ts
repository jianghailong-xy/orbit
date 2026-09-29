import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiPlans } from '../wiki/wiki-plan';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import type { WikiPrincipal } from '../wiki/wiki.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The plan, on the runner door (contracts/wiki.contract.json `plan.routes`,
 * `agentSurface.doors.runner.maintenanceRoutes`): what the drafting job and the maintenance run ask —
 * the plan as it stands, a draft to store, and a change to propose — and the job's own routes (contract
 * `plan.jobs`): where its run starts, the gate round it is on, how it ended, the materials it reads,
 * and the check its task's acceptance command asks.
 *
 * ONLY A MAINTENANCE RUN OF THE SPACE. The calling session (`X-Orbit-Session-Id`, one this runner
 * hosts for its owner) is the principal, and `WikiPlans.assertMaintainer` asks it the one test
 * criterion 2 exported (`isWikiMaintenanceSession`): any other session of the owner is refused
 * WIKI_NOT_MAINTENANCE_SESSION, a headless call 400, and another owner's space is the plain 404. Nothing
 * here confirms a plan or decides a proposal: those are the owner's, on the user door.
 *
 * A controller of its own beside the articles', so that neither injects anything it did not.
 */
@UseGuards(RunnerAuthGuard, WikiRolloutGuard)
@Controller('runner/wiki')
export class RunnerWikiPlanController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: WikiPlans,
  ) {}

  /** The version in force, the draft, and the pending proposals: what a redraft and a proposal start from. */
  @Get('spaces/:id/plan')
  async state(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.plans.stateForMaintainer(await this.maintainer(runner, callingSessionId), id);
  }

  /** A whole plan, gated and stored as the space's new draft, or refused WIKI_PLAN_GATE with every error. */
  @Post('spaces/:id/plan/drafts')
  @HttpCode(HttpStatus.OK)
  async draft(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.plans.submitDraft(await this.maintainer(runner, callingSessionId), id, body);
  }

  /** A change to the confirmed plan, gated and kept pending until the owner answers it. */
  @Post('spaces/:id/plan/proposals')
  @HttpCode(HttpStatus.OK)
  async propose(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.plans.propose(await this.maintainer(runner, callingSessionId), id, body);
  }

  // ── The plan's jobs (contract `plan.jobs`) ────────────────────────────────────────────────────

  /** The job this maintenance run runs, and the space and checkout it starts from; recorded as started. */
  @Get('spaces/:id/plan/job')
  async job(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.plans.jobContext(await this.maintainer(runner, callingSessionId), id);
  }

  /** The gate round the run is on: what the plan page shows while it runs. */
  @Post('spaces/:id/plan/job/progress')
  @HttpCode(HttpStatus.OK)
  async progress(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.plans.jobProgress(await this.maintainer(runner, callingSessionId), id, body);
  }

  /** How the run ended: the version it stored, or the gate's errors and why it failed. */
  @Post('spaces/:id/plan/job/finish')
  @HttpCode(HttpStatus.OK)
  async finish(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.plans.jobFinish(await this.maintainer(runner, callingSessionId), id, body);
  }

  /**
   * `orbit wiki plan check`: whether the job's run did what its task was made for. A task's acceptance
   * command runs with no session, so a headless call of the space's owner's runner is answered; a call
   * that names a session is held to the maintenance test like every other route here.
   */
  @Get('spaces/:id/plan/check')
  async check(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Query('jobId', PublicIdPipe) jobId?: string,
  ) {
    if (callingSessionId?.trim()) await this.plans.assertMaintainer(await this.maintainer(runner, callingSessionId), id);
    if (!jobId) throw new BadRequestException('jobId is required: the plan job the task was made for (--job)');
    return this.plans.jobCheck(runner.ownerId, id, jobId);
  }

  /** What a draft reads of Orbit besides the repository: projects, the space's sessions, its entries and topics. */
  @Get('spaces/:id/plan/materials')
  async materials(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.plans.materials(await this.maintainer(runner, callingSessionId), id);
  }

  /**
   * The calling session as a principal. Whether it is a maintenance run of the space the service asks,
   * after the space is found; this only proves the session is one this runner hosts for its owner.
   */
  private async maintainer(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<WikiPrincipal> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException(
        'missing session context: only a Wiki maintenance run of this space drafts or proposes to its plan, so this door needs X-Orbit-Session-Id',
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
    return { origin: 'maintenance', ownerId: runner.ownerId, userId: null, sessionId, toolCallId: null };
  }
}
