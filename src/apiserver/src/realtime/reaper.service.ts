import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
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
        assignedRunnerId: true,
        status: true,
        lastTurnAt: true,
        cancelRequestedAt: true,
        assignedRunner: { select: { lastHeartbeatAt: true, status: true } },
      },
    });
    for (const s of sessions) {
      try {
        const hb = s.assignedRunner?.lastHeartbeatAt?.getTime() ?? 0;
        const offline =
          !s.assignedRunner || s.assignedRunner.status === 'OFFLINE' || now - hb > OFFLINE_AFTER_MS;
        if (offline) {
          await this.forceFail(s.id, s.assignedRunnerId, 'runner offline');
          continue;
        }
        // Online runner that hasn't honored a cancel/end in time: the session is
        // wedged (e.g. a restarted runner that never re-attached). Force-finalize so
        // the slot is freed; without this both branches below skip it forever.
        const cancelAt = s.cancelRequestedAt?.getTime() ?? 0;
        if (cancelAt && now - cancelAt > CANCEL_GRACE_MS) {
          await this.forceFail(s.id, s.assignedRunnerId, 'cancel not honored');
          continue;
        }
        const lastTurn = s.lastTurnAt?.getTime() ?? 0;
        if (
          s.status === RunStatus.AWAITING_INPUT &&
          !s.cancelRequestedAt &&
          now - lastTurn > IDLE_AFTER_MS
        ) {
          await this.endIdle(s.id, s.assignedRunnerId, idleCutoff);
        }
      } catch (e) {
        // Isolate per-session failures so one doesn't skip the rest; retried next sweep.
        this.log.error(`reap of ${s.id} failed: ${(e as Error).message}`);
      }
    }
  }

  /** Dead runner: finalize session, drain queued turns, signal + publish terminal. */
  private async forceFail(
    sessionId: string,
    runnerId: string | null,
    reason: string,
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

  /** Live runner but idle too long: gracefully end via an inbox 'end' turn + cancel. */
  private async endIdle(
    sessionId: string,
    runnerId: string | null,
    idleCutoff: Date,
  ): Promise<void> {
    // Claim the teardown atomically: re-evaluate idleness at execution time and put
    // the cancelRequestedAt flip + the 'end' turn in ONE transaction so a seq P2002
    // rolls BOTH back (no half-ended, wedged session). Retried next sweep if so.
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: {
          id: sessionId,
          status: RunStatus.AWAITING_INPUT,
          cancelRequestedAt: null,
          lastTurnAt: { lt: idleCutoff },
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
    this.log.log(`ending idle session ${sessionId}`);
  }
}
