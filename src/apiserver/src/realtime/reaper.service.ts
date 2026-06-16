import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RunStatus, TaskStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from './realtime.service';

const REAP_INTERVAL_MS = 30_000;
const OFFLINE_AFTER_MS = 90_000; // runner missed ~3 heartbeats
const IDLE_AFTER_MS = 30 * 60_000; // gracefully end a session idle this long
// A cancel/end a live (online) runner hasn't honored within this window means the
// run is wedged — e.g. the runner restarted and never re-attached (no reclaim), so
// it can't see the inbox 'end' or the heartbeat cancel. Force-finalize it so the
// leaked AWAITING_INPUT run can't hold a concurrency slot forever.
const CANCEL_GRACE_MS = 2 * 60_000;

const LIVE: RunStatus[] = [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];

/**
 * Background sweeper for interactive sessions (Route B). Without it, a session
 * whose runner dies would sit RUNNING/AWAITING_INPUT forever, leaking a run and a
 * concurrency slot and showing the UI a live-but-dead chat. v1 is single-replica;
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
    const runs = await this.prisma.taskRun.findMany({
      where: { interactive: true, status: { in: LIVE } },
      select: {
        id: true,
        taskId: true,
        runnerId: true,
        status: true,
        lastTurnAt: true,
        cancelRequestedAt: true,
        runner: { select: { lastHeartbeatAt: true, status: true } },
      },
    });
    for (const r of runs) {
      try {
        const hb = r.runner?.lastHeartbeatAt?.getTime() ?? 0;
        const offline = !r.runner || r.runner.status === 'OFFLINE' || now - hb > OFFLINE_AFTER_MS;
        if (offline) {
          await this.forceFail(r.id, r.taskId, r.runnerId, 'runner offline');
          continue;
        }
        // Online runner that hasn't honored a cancel/end in time: the run is wedged
        // (e.g. a restarted runner that never re-attached). Force-finalize so the
        // slot is freed; without this both branches below skip it forever.
        const cancelAt = r.cancelRequestedAt?.getTime() ?? 0;
        if (cancelAt && now - cancelAt > CANCEL_GRACE_MS) {
          await this.forceFail(r.id, r.taskId, r.runnerId, 'cancel not honored');
          continue;
        }
        const lastTurn = r.lastTurnAt?.getTime() ?? 0;
        if (r.status === RunStatus.AWAITING_INPUT && !r.cancelRequestedAt && now - lastTurn > IDLE_AFTER_MS) {
          await this.endIdle(r.id, r.runnerId, idleCutoff);
        }
      } catch (e) {
        // Isolate per-run failures (e.g. a seq P2002) so one doesn't skip the rest;
        // the row is retried on the next sweep.
        this.log.error(`reap of ${r.id} failed: ${(e as Error).message}`);
      }
    }
  }

  /** Dead runner: finalize run + task, drain queued turns, signal + publish terminal. */
  private async forceFail(
    runId: string,
    taskId: string,
    runnerId: string | null,
    reason: string,
  ): Promise<void> {
    const ok = await this.prisma.$transaction(async (tx) => {
      const res = await tx.taskRun.updateMany({
        where: { id: runId, status: { in: LIVE } },
        // Set cancelRequestedAt too so the heartbeat cancel-drain tells a runner
        // recovering from a partition to stop (the run is already finalized here).
        data: {
          status: RunStatus.FAILED,
          error: reason,
          finishedAt: new Date(),
          cancelRequestedAt: new Date(),
        },
      });
      if (res.count === 0) return false;
      await tx.task.updateMany({
        where: { id: taskId, status: { not: TaskStatus.CANCELLED } },
        data: { status: TaskStatus.FAILED },
      });
      await tx.conversationTurn.updateMany({
        where: { runId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      return true;
    });
    if (!ok) return;
    // Tell the runner to stop in case the "offline" was a recovering partition and
    // the claude process is in fact still alive (heartbeat fallback).
    if (runnerId) this.realtime.requestCancel(runnerId, runId);
    this.realtime.publish(runId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      payload: { status: RunStatus.FAILED, final: true, reason },
    });
    this.log.warn(`reaped dead-runner session ${runId} (${reason})`);
  }

  /** Live runner but idle too long: gracefully end via an inbox 'end' turn + cancel. */
  private async endIdle(runId: string, runnerId: string | null, idleCutoff: Date): Promise<void> {
    // Claim the teardown atomically: re-evaluate idleness at execution time (a turn
    // that arrived since the snapshot bumps lastTurnAt and is excluded), and put the
    // cancelRequestedAt flip + the 'end' turn in ONE transaction so a seq P2002
    // rolls BOTH back (no half-ended, wedged session). Retried next sweep if so.
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.taskRun.updateMany({
        where: {
          id: runId,
          status: RunStatus.AWAITING_INPUT,
          cancelRequestedAt: null,
          lastTurnAt: { lt: idleCutoff },
        },
        data: { cancelRequestedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      const last = await tx.conversationTurn.findFirst({
        where: { runId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await tx.conversationTurn.create({
        data: {
          runId,
          seq: (last?.seq ?? 0) + 1,
          clientTurnId: randomUUID(),
          kind: 'end',
          status: 'PENDING',
        },
      });
      return true;
    });
    if (!done) return;
    if (runnerId) this.realtime.requestCancel(runnerId, runId);
    this.realtime.notifyInbox(runId);
    this.log.log(`ending idle session ${runId}`);
  }
}
