import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RunStatus, TaskStatus } from '@prisma/client';
import { RunEventType, isApiErrorText } from '@orbit/shared';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { reclaimStalledTask } from '../tasks/reclaim-stalled-task';
import { RealtimeService } from './realtime.service';

const REAP_INTERVAL_MS = 30_000;
const OFFLINE_AFTER_MS = 90_000; // runner missed ~3 heartbeats
const IDLE_AFTER_MS = 30 * 60_000; // gracefully end a session idle this long
// A cancel/end a live (online) runner hasn't honored within this window means the
// session is wedged — e.g. the runner restarted and never re-attached (no reclaim),
// so it can't see the inbox 'end' or the heartbeat cancel. Force-finalize it so the
// leaked AWAITING_INPUT session can't hold a concurrency slot forever.
const CANCEL_GRACE_MS = 2 * 60_000;

const LIVE: RunStatus[] = [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];

// A task in a terminal state has no work left, so a session still parked at
// AWAITING_INPUT for it (e.g. a "开始执行" run whose agent marked the task DONE) is
// just holding a concurrency slot. Recycle it immediately instead of waiting out
// IDLE_AFTER_MS. Covers DONE from either the agent (MCP) or a manual user edit.
const TASK_TERMINAL: TaskStatus[] = [TaskStatus.DONE, TaskStatus.CANCELLED];

/**
 * Background sweeper for interactive sessions (Route B). Without it, a session
 * whose runner dies would sit RUNNING/AWAITING_INPUT forever, leaking a session and
 * a concurrency slot and showing the UI a live-but-dead chat. v1 is single-replica;
 * for multi-replica this needs a leader lock (deferred to the HA phase).
 */
@Injectable()
export class ReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Reaper');
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.sweep().catch((e) => this.log.error('sweep failed: ' + (e as Error).message));
    }, REAP_INTERVAL_MS);
    this.timer.unref(); // don't keep the process alive just for the reaper
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const idleCutoff = new Date(now - IDLE_AFTER_MS);
    const sessions = await this.prisma.session.findMany({
      where: { status: { in: LIVE } },
      select: {
        id: true,
        taskId: true,
        assignedRunnerId: true,
        status: true,
        lastTurnAt: true,
        cancelRequestedAt: true,
        task: { select: { status: true } },
        assignedRunner: { select: { lastHeartbeatAt: true, status: true } },
      },
    });
    for (const s of sessions) {
      try {
        const hb = s.assignedRunner?.lastHeartbeatAt?.getTime() ?? 0;
        const offline =
          !s.assignedRunner || s.assignedRunner.status === 'OFFLINE' || now - hb > OFFLINE_AFTER_MS;
        if (offline) {
          await this.forceFail(s.id, s.assignedRunnerId, s.taskId, 'runner offline');
          continue;
        }
        // Online runner that hasn't honored a cancel/end in time: the session is
        // wedged (e.g. a restarted runner that never re-attached). Force-finalize so
        // the slot is freed; without this both branches below skip it forever.
        const cancelAt = s.cancelRequestedAt?.getTime() ?? 0;
        if (cancelAt && now - cancelAt > CANCEL_GRACE_MS) {
          await this.forceFail(s.id, s.assignedRunnerId, s.taskId, 'cancel not honored');
          continue;
        }
        // Backstop for a task run whose last turn ended in a Claude API error (e.g.
        // content filtering): the SDK reports it as a successful turn, so an older
        // runner parks the session at AWAITING_INPUT and the task stays IN_PROGRESS
        // with nothing watching. (Current runners flag the turn FAILED at the source,
        // so this only catches sessions a stale runner left behind.) Finalize FAILED and
        // reclaim the task as FAILED. Task-bound, online, not-being-cancelled only.
        if (s.status === RunStatus.AWAITING_INPUT && s.taskId && !s.cancelRequestedAt) {
          const last = await this.prisma.runEvent.findFirst({
            where: { sessionId: s.id, type: RunEventType.ASSISTANT },
            orderBy: { seq: 'desc' },
            select: { payload: true },
          });
          const text = (last?.payload as { text?: string } | null)?.text;
          if (isApiErrorText(text)) {
            await this.forceFail(
              s.id,
              s.assignedRunnerId,
              s.taskId,
              'run failed (API error)',
              TaskStatus.FAILED,
            );
            continue;
          }
        }
        const lastTurn = s.lastTurnAt?.getTime() ?? 0;
        // Tear a parked session down when its task is already finished (recycle the
        // slot now) or when it has sat idle past IDLE_AFTER_MS.
        const taskDone = !!s.task && TASK_TERMINAL.includes(s.task.status);
        if (
          s.status === RunStatus.AWAITING_INPUT &&
          !s.cancelRequestedAt &&
          (taskDone || now - lastTurn > IDLE_AFTER_MS)
        ) {
          await this.endParked(s.id, s.assignedRunnerId, idleCutoff);
        }
      } catch (e) {
        // Isolate per-session failures so one doesn't skip the rest; retried next sweep.
        this.log.error(`reap of ${s.id} failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Finalize a session FAILED, drain queued turns, signal + publish terminal. `resetTaskTo`
   * is how a now-stalled IN_PROGRESS task is reclaimed: OPEN for a retryable end (dead/
   * partitioned runner, unhonored cancel) or FAILED for a genuine run failure.
   */
  private async forceFail(
    sessionId: string,
    runnerId: string | null,
    taskId: string | null,
    reason: string,
    resetTaskTo: TaskStatus = TaskStatus.OPEN,
  ): Promise<void> {
    const ok = await this.prisma.$transaction(async (tx) => {
      const res = await tx.session.updateMany({
        where: { id: sessionId, status: { in: LIVE } },
        // Set cancelRequestedAt too so the heartbeat cancel-drain tells a runner
        // recovering from a partition to stop (the session is already finalized here).
        data: {
          status: RunStatus.FAILED,
          error: reason,
          finishedAt: new Date(),
          cancelRequestedAt: new Date(),
        },
      });
      if (res.count === 0) return false;
      await tx.conversationTurn.updateMany({
        where: { sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      // Reclaim a now-stalled IN_PROGRESS task so it stops showing as running.
      if (taskId) await reclaimStalledTask(tx, taskId, resetTaskTo);
      return true;
    });
    if (!ok) return;
    if (runnerId) this.realtime.requestCancel(runnerId, sessionId);
    this.realtime.publish(sessionId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      payload: { status: RunStatus.FAILED, final: true, reason },
    });
    this.log.warn(`reaped dead-runner session ${sessionId} (${reason})`);
  }

  /**
   * Gracefully tear down a session parked at AWAITING_INPUT (inbox 'end' turn +
   * cancel), freeing its concurrency slot. Triggered when the session's task is
   * already terminal (its work is done) or when it has been idle past IDLE_AFTER_MS.
   */
  private async endParked(
    sessionId: string,
    runnerId: string | null,
    idleCutoff: Date,
  ): Promise<void> {
    // Claim the teardown atomically: re-evaluate the trigger at execution time and put
    // the cancelRequestedAt flip + the 'end' turn in ONE transaction so a seq P2002
    // rolls BOTH back (no half-ended, wedged session). Retried next sweep if so. The
    // re-check mirrors sweep() — still parked, and either its task is terminal or it's
    // still idle — so a turn that arrived since the sweep read doesn't get cut off.
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: {
          id: sessionId,
          status: RunStatus.AWAITING_INPUT,
          cancelRequestedAt: null,
          OR: [{ task: { status: { in: TASK_TERMINAL } } }, { lastTurnAt: { lt: idleCutoff } }],
        },
        data: { cancelRequestedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      const last = await tx.conversationTurn.findFirst({
        where: { sessionId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.conversationTurn.create({
        data: {
          sessionId,
          seq: (last?.seq ?? 0) + 1,
          clientTurnId: randomUUID(),
          kind: 'end',
          status: 'PENDING',
        },
      });
      return true;
    });
    if (!done) return;
    if (runnerId) this.realtime.requestCancel(runnerId, sessionId);
    this.realtime.notifyInbox(sessionId);
    this.log.log(`recycling parked session ${sessionId}`);
  }
}
