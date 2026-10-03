import { Injectable, NotFoundException } from '@nestjs/common';
import {
  wikiMaintenanceLook,
  wikiMaintenanceSettings,
  type WikiCursorOutcome,
  type WikiMaintenanceFailureKind,
  type WikiMaintenanceHealth,
  type WikiMaintenanceHeldReason,
  type WikiSpaceHealth,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { countBacklog, spaceScope, type FactPosition } from './wiki-maintenance';
import { wikiMaintenanceCatchUpOf, wikiMaintenanceRunsToday } from './wiki-maintenance-session';
import { wikiMaintenanceProviderIsLocal } from './wiki-maintenance-settings';

/**
 * A space's health, as the Wiki home's status line reads it (contracts/wiki.contract.json
 * `maintenance.health`, criterion 5): how many entries the space holds, and where its maintenance run
 * stands — when it last succeeded, how far behind it is, how many runs in a row failed, whether it is
 * on, and whether today's runs are used up.
 *
 * A READ AND NOTHING ELSE. The cursor row is read if there is one and never made: a space that never ran
 * has none, and reads as a cursor at the beginning. The backlog is counted from the facts as the read is
 * made — the copy the cursor row keeps is as old as the last run that wrote it — and only while
 * maintenance is on, which is the only time the line shows it.
 *
 * What the owner is told when runs keep failing is not here: it is the failure report's own
 * (`WikiMaintenance.advanceCursor`), sent once by the report that makes the streak the threshold.
 */
@Injectable()
export class WikiHealth {
  constructor(private readonly prisma: PrismaService) {}

  async read(ownerId: string, spaceId: string, now: Date = new Date()): Promise<WikiSpaceHealth> {
    const space = await this.prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { settings: true } });
    if (!space) throw new NotFoundException('no such wiki space');
    const settings = wikiMaintenanceSettings((space.settings as Record<string, unknown> | null)?.maintenance);
    const entries = await this.prisma.wikiEntry.count({ where: { ownerId, spaceId, status: 'active' } });
    const cursor = await this.prisma.wikiCursor.findFirst({
      where: { spaceId, ownerId, source: 'facts' },
      select: {
        positionAt: true,
        positionKind: true,
        positionRef: true,
        lastOkAt: true,
        lastRunAt: true,
        consecutiveFailures: true,
        heldReason: true,
        heldAt: true,
      },
    });

    let backlog = 0;
    let oldestPendingAt: Date | null = null;
    if (settings.enabled) {
      const watermark: FactPosition | null = cursor?.positionAt && cursor.positionKind && cursor.positionRef
        ? { at: cursor.positionAt, kind: cursor.positionKind as FactPosition['kind'], ref: cursor.positionRef }
        : null;
      const counted = await countBacklog(this.prisma, await spaceScope(this.prisma, ownerId, spaceId), watermark);
      backlog = counted.backlog;
      oldestPendingAt = counted.oldestPendingAt;
    }
    const today = await wikiMaintenanceRunsToday(this.prisma, ownerId, spaceId, now);
    // A run made in active catch-up on a local endpoint is not counted against the day (contract
    // `maintenance.job.catchUp.dailyLimit`): while that holds, the day's limit holds no run back.
    const uncounted = settings.enabled
      && (await wikiMaintenanceCatchUpOf(this.prisma, ownerId, spaceId, oldestPendingAt, now)).state === 'active'
      && (await wikiMaintenanceProviderIsLocal(this.prisma, ownerId, settings.provider));

    const maintenance: Omit<WikiMaintenanceHealth, 'look'> = {
      enabled: settings.enabled,
      lastOkAt: cursor?.lastOkAt?.toISOString() ?? null,
      lastRunAt: cursor?.lastRunAt?.toISOString() ?? null,
      consecutiveFailures: cursor?.consecutiveFailures ?? 0,
      backlog,
      oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
      lagSeconds: oldestPendingAt ? Math.max(0, Math.floor((now.getTime() - oldestPendingAt.getTime()) / 1000)) : 0,
      dailyLimitReached: !uncounted && today.remaining <= 0,
      held: cursor?.heldReason && cursor.heldAt
        ? { reason: cursor.heldReason as WikiMaintenanceHeldReason, at: cursor.heldAt.toISOString() }
        : null,
      running: await this.running(ownerId, spaceId),
      lastRun: await this.lastRun(ownerId, spaceId),
      lastFailure: await this.lastFailure(ownerId, spaceId),
    };
    return { spaceId, entries, maintenance: { look: wikiMaintenanceLook(maintenance, now), ...maintenance } };
  }

  /**
   * The run under way: the latest that started and has not ended, while its task has not ended either —
   * started when its latest attempt did (a retry's or a rerun's start, not the run's first).
   */
  private async running(ownerId: string, spaceId: string): Promise<WikiMaintenanceHealth['running']> {
    const run = await this.prisma.wikiMaintenanceRun.findFirst({
      where: { ownerId, spaceId, startedAt: { not: null }, endedAt: null },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { taskId: true, sessionId: true, startedAt: true, lastStartedAt: true },
    });
    const startedAt = run?.lastStartedAt ?? run?.startedAt;
    if (!run || !startedAt) return null;
    // A run whose session died without saying how it ended leaves its row open; its task has ended.
    const task = await this.prisma.task.findFirst({
      where: { id: run.taskId, ownerId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      select: { id: true },
    });
    return task ? { sessionId: run.sessionId, startedAt: startedAt.toISOString() } : null;
  }

  /** The run that ended last, and how: the session the status line's View run opens. */
  private async lastRun(ownerId: string, spaceId: string): Promise<WikiMaintenanceHealth['lastRun']> {
    const run = await this.prisma.wikiMaintenanceRun.findFirst({
      where: { ownerId, spaceId, endedAt: { not: null } },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      select: { sessionId: true, outcome: true, endedAt: true },
    });
    return run?.endedAt
      ? { sessionId: run.sessionId, outcome: (run.outcome as WikiCursorOutcome | null) ?? null, endedAt: run.endedAt.toISOString() }
      : null;
  }

  /**
   * Of the runs whose latest attempt failed, the one that ended last, and whose failure it was (contract
   * `maintenance.job.recovery.failureKinds`): what a client tells the platform failing from the run failing
   * by. A run row says how its latest attempt ended, so a run that failed and then succeeded is none of them.
   */
  private async lastFailure(ownerId: string, spaceId: string): Promise<WikiMaintenanceHealth['lastFailure']> {
    const run = await this.prisma.wikiMaintenanceRun.findFirst({
      where: { ownerId, spaceId, outcome: { in: ['failed', 'truncated'] }, endedAt: { not: null } },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      select: { sessionId: true, failureKind: true, error: true, endedAt: true },
    });
    return run?.endedAt
      ? {
        kind: run.failureKind === 'infra' ? 'infra' : ('content' as WikiMaintenanceFailureKind),
        reason: run.error,
        at: run.endedAt.toISOString(),
        sessionId: run.sessionId,
      }
      : null;
  }
}
