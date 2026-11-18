import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { type CoordinatorHandoffFailureCode, type CoordinatorHandoffView, RunEventType } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  type CoordinatorHandoffRow,
  HANDOFF_NOTE_QUEUED_TIMEOUT_MS,
  HANDOFF_NOTE_TURN_TIMEOUT_MS,
  HANDOFF_ROW_SELECT,
  LIVE_HANDOFF_STATES,
  coordinatorHandoffPrompt,
  coordinatorHandoffTurnId,
  coordinatorHandoffView,
} from './coordinator-handoff';
import { ProjectsService } from './projects.service';

/** How often WRITING handoffs are looked at for a note turn that timed out or was taken away. */
const SWEEP_MS = 30_000;
/** A note turn answered this long ago whose end the turn-complete hook never settled. */
const ANSWERED_GRACE_MS = 60_000;

/**
 * Coordinator handoff — "Start a new coordinator" with a handoff note (board 02,
 * docs/coordinator-handoff.md).
 *
 *   start → a platform turn (`coordinator-handoff:v1:<id>:<attempt>`, NEXT_TURN, so after a running
 *           turn) asks the outgoing coordinator for a note in four fixed sections. State WRITING.
 *   its turn SUCCEEDS (`afterTurn`, from runnerApi.turnComplete) → its final assistant text is the
 *           note; HANDING_OVER, then `ProjectsService.coordinator(…, 'replace', handoff)` — the one
 *           replacement — opens the successor with the note in its opening, moves the waits and turns
 *           the row COMPLETED in the swap's own transaction.
 *   its turn FAILS, is STOPPED or TIMES OUT → FAILED with a code. Nothing else is written: the old
 *           coordinator stays current and no wait moves, because the replacement never ran.
 *   skip   → HANDING_OVER with no note, then the same replacement (from WRITING or FAILED).
 *   cancel → CANCELLED, and the note turn withdrawn (queued) or stopped (running). Nothing changes.
 *   retry  → from FAILED, a new attempt: a new note turn under a new key.
 *
 * Every transition is a compare-and-set on the row's state (and attempt, for a turn's end), so a
 * late end of a turn the owner already skipped, cancelled or retried past settles nothing.
 */
@Injectable()
export class CoordinatorHandoffService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoordinatorHandoffService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly sessions: SessionsService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((e) => this.logger.error(`handoff sweep failed: ${(e as Error).message}`));
    }, SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── The owner's doors ────────────────────────────────────────────────────────────────────────

  /** Hand over: ask the current coordinator for its note. A live handoff is answered as it stands. */
  async start(ownerId: string, projectId: string): Promise<CoordinatorHandoffView> {
    const coordinator = await this.openCoordinator(ownerId, projectId);
    const live = await this.liveRow(coordinator.id);
    if (live?.state === 'FAILED') return this.retry(ownerId, projectId);
    if (live) return coordinatorHandoffView(live);

    const id = randomUUID();
    const clientTurnId = coordinatorHandoffTurnId(id, 1);
    let row: CoordinatorHandoffRow;
    try {
      row = await this.prisma.coordinatorHandoff.create({
        data: { id, ownerId, projectId, fromSessionId: coordinator.id, state: 'WRITING', attempt: 1, clientTurnId },
        select: HANDOFF_ROW_SELECT,
      });
    } catch (e) {
      // Two presses at once meet one row (coordinator_handoff_one_live_idx).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.liveRow(coordinator.id);
        if (winner) return coordinatorHandoffView(winner);
      }
      throw e;
    }
    try {
      await this.queueNoteTurn(ownerId, coordinator.id, clientTurnId);
    } catch (e) {
      // The turn was refused, so nothing is under way: the handoff never started.
      await this.prisma.coordinatorHandoff.updateMany({
        where: { id, state: 'WRITING' },
        data: { state: 'CANCELLED', endedAt: new Date() },
      });
      throw e;
    }
    this.publish(row);
    return coordinatorHandoffView(row);
  }

  /** Skip the note / Hand over without a note: the replacement with no note, from WRITING or FAILED. */
  async skip(ownerId: string, projectId: string): Promise<CoordinatorHandoffView> {
    const project = await this.project(ownerId, projectId);
    const fromSessionId = project.coordinatorSessionId;
    if (!fromSessionId) throw new ConflictException('this project has no coordinator to hand over');
    const live = await this.liveRow(fromSessionId);
    let row: CoordinatorHandoffRow;
    if (live) {
      if (live.state === 'HANDING_OVER') throw new ConflictException('this handover is already under way');
      const moved = await this.prisma.coordinatorHandoff.updateMany({
        where: { id: live.id, state: live.state },
        data: { state: 'HANDING_OVER', note: null, failureCode: null, endedAt: null },
      });
      if (moved.count === 0) throw new ConflictException('this handover changed while it was being skipped — try again');
      row = { ...live, state: 'HANDING_OVER', note: null, failureCode: null, endedAt: null };
    } else {
      // Hand over without a note was pressed with no handoff under way: the same replacement.
      row = await this.prisma.coordinatorHandoff.create({
        data: { id: randomUUID(), ownerId, projectId, fromSessionId, state: 'HANDING_OVER', attempt: 1 },
        select: HANDOFF_ROW_SELECT,
      });
    }
    this.publish(row);
    return this.replace(ownerId, row, null);
  }

  /** Cancel handover / Keep this coordinator: abandon it, and nothing changes. */
  async cancel(ownerId: string, projectId: string): Promise<CoordinatorHandoffView> {
    const project = await this.project(ownerId, projectId);
    const live = project.coordinatorSessionId ? await this.liveRow(project.coordinatorSessionId) : null;
    if (!live) throw new ConflictException('there is no handover to cancel');
    if (live.state === 'HANDING_OVER') {
      throw new ConflictException('this handover is already under way and can no longer be cancelled');
    }
    const cancelled = await this.prisma.coordinatorHandoff.updateMany({
      where: { id: live.id, state: live.state },
      data: { state: 'CANCELLED', failureCode: null, endedAt: new Date() },
    });
    if (cancelled.count === 0) throw new ConflictException('this handover changed while it was being cancelled — try again');
    if (live.state === 'WRITING') await this.withdrawNoteTurn(live);
    const row = { ...live, state: 'CANCELLED', failureCode: null, endedAt: new Date() };
    this.publish(row);
    return coordinatorHandoffView(row);
  }

  /** Try again: after a failure, a new attempt's note turn. */
  async retry(ownerId: string, projectId: string): Promise<CoordinatorHandoffView> {
    const project = await this.project(ownerId, projectId);
    const live = project.coordinatorSessionId ? await this.liveRow(project.coordinatorSessionId) : null;
    if (!live) throw new ConflictException('there is no failed handover to try again');
    if (live.state === 'WRITING') return coordinatorHandoffView(live);
    if (live.state !== 'FAILED') throw new ConflictException('this handover is already under way');
    const attempt = live.attempt + 1;
    const clientTurnId = coordinatorHandoffTurnId(live.id, attempt);
    const startedAt = new Date();
    const moved = await this.prisma.coordinatorHandoff.updateMany({
      where: { id: live.id, state: 'FAILED', attempt: live.attempt },
      data: { state: 'WRITING', attempt, clientTurnId, startedAt, failureCode: null, endedAt: null },
    });
    if (moved.count === 0) throw new ConflictException('this handover changed while it was being retried — try again');
    try {
      await this.queueNoteTurn(ownerId, live.fromSessionId, clientTurnId);
    } catch (e) {
      await this.fail(live.id, attempt, 'TURN_FAILED');
      throw e;
    }
    const row = { ...live, state: 'WRITING', attempt, clientTurnId, startedAt, failureCode: null, endedAt: null };
    this.publish(row);
    return coordinatorHandoffView(row);
  }

  // ── The note turn's end ──────────────────────────────────────────────────────────────────────

  /**
   * A turn of `sessionId` ended (runnerApi.turnComplete, after its commit). Only the note turn of a
   * WRITING handoff's current attempt is acted on: SUCCEEDED takes its final assistant text as the
   * note and runs the replacement; anything else is FAILED, and nothing else changes.
   */
  async afterTurn(sessionId: string, turnId: string, status: RunStatus | string): Promise<void> {
    const row = await this.prisma.coordinatorHandoff.findFirst({
      where: { fromSessionId: sessionId, state: 'WRITING' },
      select: HANDOFF_ROW_SELECT,
    });
    if (!row?.clientTurnId) return;
    const turn = await this.prisma.conversationTurn.findFirst({
      where: { id: turnId, sessionId },
      select: { clientTurnId: true },
    });
    if (turn?.clientTurnId !== row.clientTurnId) return;
    if (status !== RunStatus.SUCCEEDED) {
      await this.fail(row.id, row.attempt, status === RunStatus.INTERRUPTED ? 'TURN_STOPPED' : 'TURN_FAILED');
      return;
    }
    await this.noteWritten(row, turnId);
  }

  /**
   * The WRITING handoffs whose note turn will not end by itself: taken off the queue or dropped with
   * a stop (TURN_STOPPED), its conversation ended (TURN_STOPPED) or failed (TURN_FAILED), or past
   * its time (TIMED_OUT — a running one is stopped as well). And one answered whose end the hook
   * never settled (a crash between the two) is settled here from what the turn left. Answers how many
   * it settled.
   */
  async sweep(now = new Date()): Promise<number> {
    const rows = await this.prisma.coordinatorHandoff.findMany({
      where: { state: 'WRITING' },
      select: HANDOFF_ROW_SELECT,
      take: 100,
    });
    let settled = 0;
    for (const row of rows) {
      if (!row.clientTurnId) continue;
      const [session, turn] = await Promise.all([
        this.prisma.session.findUnique({
          where: { id: row.fromSessionId },
          select: { status: true, completedAt: true, archivedAt: true, deletedAt: true },
        }),
        this.prisma.conversationTurn.findUnique({
          where: { sessionId_clientTurnId: { sessionId: row.fromSessionId, clientTurnId: row.clientTurnId } },
          select: { id: true, status: true, deliveredAt: true, answeredAt: true },
        }),
      ]);
      let code: CoordinatorHandoffFailureCode | null = null;
      if (!session || session.completedAt || session.archivedAt || session.deletedAt) code = 'TURN_STOPPED';
      else if (!turn) code = 'TURN_STOPPED';
      else if (turn.status === 'ANSWERED') {
        if (turn.answeredAt && now.getTime() - turn.answeredAt.getTime() < ANSWERED_GRACE_MS) continue;
        if (session.status === RunStatus.FAILED) code = 'TURN_FAILED';
        else {
          await this.noteWritten(row, turn.id);
          settled += 1;
          continue;
        }
      } else if (turn.deliveredAt
        ? now.getTime() - turn.deliveredAt.getTime() > HANDOFF_NOTE_TURN_TIMEOUT_MS
        : now.getTime() - row.startedAt.getTime() > HANDOFF_NOTE_QUEUED_TIMEOUT_MS) {
        code = 'TIMED_OUT';
      }
      if (!code) continue;
      if (await this.fail(row.id, row.attempt, code)) {
        settled += 1;
        if (code === 'TIMED_OUT') await this.withdrawNoteTurn(row);
      }
    }
    return settled;
  }

  // ── Inside ───────────────────────────────────────────────────────────────────────────────────

  /** The note is in: HANDING_OVER with it, then the replacement. An empty reply is a failure. */
  private async noteWritten(row: CoordinatorHandoffRow, turnId: string): Promise<void> {
    const note = await this.finalAssistantText(row.fromSessionId, turnId);
    if (!note) {
      await this.fail(row.id, row.attempt, 'EMPTY_NOTE');
      return;
    }
    const moved = await this.prisma.coordinatorHandoff.updateMany({
      where: { id: row.id, state: 'WRITING', attempt: row.attempt },
      data: { state: 'HANDING_OVER', note },
    });
    if (moved.count === 0) return;
    const handingOver = { ...row, state: 'HANDING_OVER', note };
    this.publish(handingOver);
    await this.replace(row.ownerId, handingOver, note).catch((e) => this.logger.warn(
      `handoff ${row.id}: the replacement failed: ${e instanceof Error ? e.message : String(e)}`,
    ));
  }

  /**
   * The replacement — `ProjectsService.coordinator(…, 'replace')`, the only one — for a HANDING_OVER
   * row. It turns the row COMPLETED in its own swap transaction; a replacement that throws leaves the
   * row FAILED (REPLACE_FAILED) and is rethrown.
   */
  private async replace(ownerId: string, row: CoordinatorHandoffRow, note: string | null): Promise<CoordinatorHandoffView> {
    try {
      const waits = await this.projects.coordinatorPendingWaits(ownerId, row.projectId);
      await this.projects.coordinator(ownerId, row.projectId, undefined, 'replace', {
        id: row.id,
        fromSessionId: row.fromSessionId,
        note,
        waits,
      });
    } catch (e) {
      const current = await this.prisma.coordinatorHandoff.updateMany({
        where: { id: row.id, state: 'HANDING_OVER' },
        data: { state: 'FAILED', failureCode: 'REPLACE_FAILED', endedAt: new Date() },
      });
      if (current.count > 0) this.publish(row);
      throw e;
    }
    const done = await this.prisma.coordinatorHandoff.findUniqueOrThrow({
      where: { id: row.id },
      select: HANDOFF_ROW_SELECT,
    });
    this.publish(done);
    return coordinatorHandoffView(done);
  }

  /** FAILED with a code, for this attempt only. True when this call moved it. */
  private async fail(id: string, attempt: number, code: CoordinatorHandoffFailureCode): Promise<boolean> {
    const failed = await this.prisma.coordinatorHandoff.updateMany({
      where: { id, state: 'WRITING', attempt },
      data: { state: 'FAILED', failureCode: code, endedAt: new Date() },
    });
    if (failed.count === 0) return false;
    const row = await this.prisma.coordinatorHandoff.findUnique({ where: { id }, select: HANDOFF_ROW_SELECT });
    if (row) this.publish(row);
    return true;
  }

  /** The turn's last top-level assistant text — a sub-agent's report to its caller is not the reply. */
  private async finalAssistantText(sessionId: string, turnId: string): Promise<string | null> {
    const events = await this.prisma.runEvent.findMany({
      where: { sessionId, turnId, type: RunEventType.ASSISTANT },
      orderBy: { seq: 'desc' },
      take: 20,
      select: { payload: true },
    });
    const text = events
      .filter((e) => !(e.payload as { parentToolUseId?: string } | null)?.parentToolUseId)
      .map((e) => (e.payload as { text?: string } | null)?.text?.trim() ?? '')
      .find((value) => value.length > 0);
    return text ?? null;
  }

  /** The platform's turn asking for the note: NEXT_TURN, so a running turn finishes first. */
  private async queueNoteTurn(ownerId: string, sessionId: string, clientTurnId: string): Promise<void> {
    await this.sessions.createTurn(ownerId, sessionId, {
      clientTurnId,
      content: coordinatorHandoffPrompt(),
      intent: 'NEXT_TURN',
    });
  }

  /** Take the note turn back: off the queue when it has not run, stopped when it is running. */
  private async withdrawNoteTurn(row: CoordinatorHandoffRow): Promise<void> {
    if (!row.clientTurnId) return;
    const turn = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId: row.fromSessionId, clientTurnId: row.clientTurnId } },
      select: { id: true, status: true },
    });
    try {
      if (turn?.status === 'PENDING') await this.sessions.cancelQueuedTurn(row.ownerId, row.fromSessionId, turn.id);
      else if (turn?.status === 'IN_FLIGHT') await this.sessions.interrupt(row.ownerId, row.fromSessionId);
    } catch (e) {
      // The handoff is already settled; a turn that could not be taken back only runs to its end.
      this.logger.warn(`handoff ${row.id}: the note turn was not withdrawn: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async project(ownerId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: {
        id: true,
        coordinatorSessionId: true,
        coordinatorSession: { select: { id: true, deletedAt: true, completedAt: true, archivedAt: true } },
      },
    });
    if (!project) throw new NotFoundException('project not found');
    return project;
  }

  /** The project's coordinator, which has to be an open conversation to write a note. */
  private async openCoordinator(ownerId: string, projectId: string): Promise<{ id: string }> {
    const project = await this.project(ownerId, projectId);
    const session = project.coordinatorSession;
    if (!session || session.deletedAt || session.completedAt || session.archivedAt) {
      throw new ConflictException(
        'this project has no open coordinator to write a handoff note — start a new coordinator without one',
      );
    }
    return { id: session.id };
  }

  private liveRow(fromSessionId: string): Promise<CoordinatorHandoffRow | null> {
    return this.prisma.coordinatorHandoff.findFirst({
      where: { fromSessionId, state: { in: [...LIVE_HANDOFF_STATES] } },
      select: HANDOFF_ROW_SELECT,
    });
  }

  /** Both sessions a handoff shows on re-read their summary. */
  private publish(row: Pick<CoordinatorHandoffRow, 'fromSessionId' | 'toSessionId'>): void {
    this.realtime?.publishSessionUpdated(row.fromSessionId);
    if (row.toSessionId) this.realtime?.publishSessionUpdated(row.toSessionId);
  }
}
