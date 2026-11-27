/**
 * The doors behind a session's `schedule_*` tools (docs/scheduled-tasks-design.md §9.1, runner-go `orbit mcp`). Every
 * write is the calling session's (X-Orbit-Session-Id, one this runner hosts for its owner), so the schedule's
 * workspace and engine are that session's, and the service judges it by §4:
 *
 *   * `schedule_create` never writes a schedule: it puts up a create card (a PENDING CREATE request) that only the
 *     owner's Create turns into one (`POST /api/schedule-requests/:id/allow`).
 *   * `schedule_update` inside the envelope applies at once and answers with the record of the change, which has
 *     Undo; outside it, it puts up an envelope card. A run's own request to widen is such a card, with
 *     askedBy RUN, and the run goes on under the access it has.
 *   * A session serving a run may update and end only the schedule it serves (SCHEDULE_RUN_SESSION_SCOPE).
 *   * `schedule_run_report` is the run's session's alone (SCHEDULE_RUN_REPORT_NOT_A_RUN otherwise).
 *
 * There is no door here, or anywhere under /runner, that answers a card: that is the owner's own press.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { toUuid } from '@orbit/shared';
import type { Runner } from '@prisma/client';

import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleCreateDto, ScheduleRunReportDto, ScheduleUpdateDto } from '../schedules/dto';
import { ScheduleReadsService } from '../schedules/schedule-reads.service';
import { ScheduleRunsService } from '../schedules/schedule-runs.service';
import { scheduleRunView } from '../schedules/schedule-views';
import { SchedulesService, type ScheduleActor, type SchedulePatch } from '../schedules/schedules.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerSchedulesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: SchedulesService,
    private readonly runs: ScheduleRunsService,
    private readonly reads: ScheduleReadsService,
  ) {}

  @Post('schedules')
  async create(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
    @Body() dto: ScheduleCreateDto,
  ) {
    const actor = await this.actor(runner, sessionHeader);
    const result = await this.schedules.create(actor, {
      intent: dto.intent,
      title: dto.title,
      prompt: dto.prompt,
      rule: dto.rule,
      timezone: dto.timezone ?? null,
      accessLevel: dto.accessLevel,
      runLimitMinutes: dto.runLimitMinutes,
      endAt: dto.endAt ? new Date(dto.endAt) : null,
      maxRuns: dto.maxRuns ?? null,
      readBack: dto.readBack ?? null,
      findings: dto.findings ?? null,
      baseline: dto.baseline,
    });
    return this.reads.createAnswer(runner.ownerId, result);
  }

  @Get('schedules')
  list(@CurrentRunner() runner: Runner, @Query('state') state?: string) {
    return this.reads.list(runner.ownerId, { state });
  }

  @Get('schedules/:id')
  get(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.reads.get(runner.ownerId, id);
  }

  @Patch('schedules/:id')
  async update(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body(PublicIdPipe.forFields('workspaceId')) dto: ScheduleUpdateDto,
  ) {
    const actor = await this.actor(runner, sessionHeader);
    const patch: SchedulePatch = {};
    for (const key of ['intent', 'title', 'prompt', 'rule', 'timezone', 'accessLevel', 'runLimitMinutes', 'workspaceId', 'readBack', 'maxRuns'] as const) {
      if (dto[key] !== undefined) (patch as Record<string, unknown>)[key] = dto[key];
    }
    if (dto.endAt !== undefined) patch.endAt = dto.endAt === null ? null : new Date(dto.endAt);
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({ code: 'SCHEDULE_PATCH_EMPTY', message: 'Name at least one field to change.' });
    }
    return this.reads.updateAnswer(runner.ownerId, await this.schedules.update(actor, id, patch));
  }

  @Post('schedules/:id/pause')
  @HttpCode(HttpStatus.OK)
  async pause(@CurrentRunner() runner: Runner, @Headers('x-orbit-session-id') s: string | undefined, @Param('id', PublicIdPipe) id: string) {
    return this.reads.controlAnswer(runner.ownerId, await this.schedules.pause(await this.actor(runner, s), id));
  }

  @Post('schedules/:id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@CurrentRunner() runner: Runner, @Headers('x-orbit-session-id') s: string | undefined, @Param('id', PublicIdPipe) id: string) {
    return this.reads.controlAnswer(runner.ownerId, await this.schedules.resume(await this.actor(runner, s), id));
  }

  @Post('schedules/:id/run')
  @HttpCode(HttpStatus.OK)
  async runNow(@CurrentRunner() runner: Runner, @Headers('x-orbit-session-id') s: string | undefined, @Param('id', PublicIdPipe) id: string) {
    return { run: scheduleRunView(await this.runs.runNow(await this.actor(runner, s), id)) };
  }

  /** ENDED (GOAL_REACHED): nothing left to watch. A run may end its own schedule this way (§8.3). */
  @Post('schedules/:id/end')
  @HttpCode(HttpStatus.OK)
  async end(@CurrentRunner() runner: Runner, @Headers('x-orbit-session-id') s: string | undefined, @Param('id', PublicIdPipe) id: string) {
    return this.reads.controlAnswer(runner.ownerId, await this.schedules.end(await this.actor(runner, s), id));
  }

  @Delete('schedules/:id')
  async remove(@CurrentRunner() runner: Runner, @Headers('x-orbit-session-id') s: string | undefined, @Param('id', PublicIdPipe) id: string) {
    return this.reads.controlAnswer(runner.ownerId, await this.schedules.remove(await this.actor(runner, s), id));
  }

  @Post('schedule-runs/:id/stop')
  @HttpCode(HttpStatus.OK)
  async stop(@CurrentRunner() runner: Runner, @Headers('x-orbit-session-id') s: string | undefined, @Param('id', PublicIdPipe) id: string) {
    return { run: scheduleRunView(await this.runs.stopRun(await this.actor(runner, s), id)) };
  }

  /** `schedule_run_report`: the calling session's own run, once; it ends the run (§7.1). */
  @Post('schedule-runs/report')
  @HttpCode(HttpStatus.OK)
  async report(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
    @Body() dto: ScheduleRunReportDto,
  ) {
    const actor = await this.actor(runner, sessionHeader);
    const { run, newFinding } = await this.runs.report(runner.ownerId, (actor as { sessionId: string }).sessionId, {
      outcome: dto.outcome,
      key: dto.key ?? null,
      summary: dto.summary,
      links: dto.links,
      ...(dto.note !== undefined ? { note: dto.note } : {}),
    });
    return { run: scheduleRunView(run), newFinding };
  }

  /** The calling session, which must be one this runner hosts for its owner. */
  private async actor(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<ScheduleActor> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException('missing session context: a schedule is changed from a session, so this door needs X-Orbit-Session-Id');
    }
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
    return { kind: 'SESSION', ownerId: runner.ownerId, sessionId: session.id };
  }
}
