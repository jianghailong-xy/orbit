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
import { readWikiRepoReadiness } from '../wiki-worker/wiki-repo-ops';
import { currentWikiExecutorSwitch, wikiExecutorView } from './wiki-executor-switch';
import { countBacklog, spaceScope, type FactPosition } from './wiki-maintenance';
import { wikiMaintenanceCatchUpOf, wikiMaintenanceRunsToday } from './wiki-maintenance-session';
import { wikiMaintenanceProviderIsLocal } from './wiki-maintenance-settings';
import { WikiSystemModelReads } from './wiki-system-model';

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
    // The server's half (contract `jobs.executor.read`, P9): whether the server executes this account's wiki,
    // and the System model it calls while it does — what the line's server reasons are said from. Under runner
    // the model is none of this account's business, and is not read.
    const executor = wikiExecutorView(currentWikiExecutorSwitch(), ownerId);
    // A run made in active catch-up on a local endpoint is not counted against the day (contract
    // `maintenance.job.catchUp.dailyLimit`): while that holds, the day's limit holds no run back. An account
    // the server executes has no provider to read (P8): the run row says whether the System model's endpoint
    // was the machine's own or a private one — the worker records it when it starts the run — and nothing
    // about a provider is validated here.
    const uncounted = settings.enabled
      && (await wikiMaintenanceCatchUpOf(this.prisma, ownerId, spaceId, oldestPendingAt, now)).state === 'active'
      && (executor.serverExecutes
        ? await this.latestRunIsLocal(ownerId, spaceId)
        : await wikiMaintenanceProviderIsLocal(this.prisma, ownerId, settings.provider));

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
    // The repository half of the line (contract `maintenance.health.repo`, design §2.2): whether the steps
    // that need a repository can run at all, and why not when they cannot — an old runner is the one a
    // person can act on, so it is named as such rather than as a wait.
    const repo = await readWikiRepoReadiness(this.prisma, { ownerId, spaceId, now });
    return {
      spaceId,
      entries,
      maintenance: { look: wikiMaintenanceLook(maintenance, now), ...maintenance },
      // The wire carries what the contract names (maintenance.health.repo): the machine's capability and
      // whether it beats. A runner that declared only `wiki-repo-op/v1` reads the old bounded window rather
      // than whole files, and that too reads as `runner_upgrade` — the one word a client acts on.
      repo: {
        look: repo.look,
        workspace: repo.workspace,
        runner: repo.runner && {
          id: repo.runner.id,
          name: repo.runner.name,
          version: repo.runner.version,
          capability: repo.runner.capability,
          online: repo.runner.online,
        },
        pending: repo.pending,
      },
      executor,
      systemModel: executor.serverExecutes ? await new WikiSystemModelReads(this.prisma).read(now) : null,
    };
  }

  /**
   * Whether the space's latest maintenance run was made on an endpoint of this machine or a private network
   * (P8): the run row's `localEndpoint`, which the worker writes when it starts a run the server executes
   * from the System model's address. A space that has not run reads as not local, as a provider nothing
   * holds does.
   */
  private async latestRunIsLocal(ownerId: string, spaceId: string): Promise<boolean> {
    const run = await this.prisma.wikiMaintenanceRun.findFirst({
      where: { ownerId, spaceId, jobId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { localEndpoint: true },
    });
    return run?.localEndpoint === true;
  }

  /**
   * The run under way: the latest that started and has not ended, while its maker has not ended either —
   * started when its latest attempt did (a retry's or a rerun's start, not the run's first). A run of a
   * task is under way while that task is (the session died without saying how: the task's end is the
   * answer); a run of a wiki job is under way while the job is (migration 0401, the server path).
   */
  private async running(ownerId: string, spaceId: string): Promise<WikiMaintenanceHealth['running']> {
    const run = await this.prisma.wikiMaintenanceRun.findFirst({
      where: { ownerId, spaceId, startedAt: { not: null }, endedAt: null },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { taskId: true, jobId: true, sessionId: true, startedAt: true, lastStartedAt: true },
    });
    const startedAt = run?.lastStartedAt ?? run?.startedAt;
    if (!run || !startedAt) return null;
    if (run.jobId) {
      const job = await this.prisma.wikiJob.findFirst({
        where: { id: run.jobId, ownerId, state: { in: ['queued', 'running', 'waiting'] } },
        select: { id: true },
      });
      return job ? { sessionId: run.sessionId, jobId: run.jobId, startedAt: startedAt.toISOString() } : null;
    }
    if (!run.taskId) return null;
    // A run whose session died without saying how it ended leaves its row open; its task has ended.
    const task = await this.prisma.task.findFirst({
      where: { id: run.taskId, ownerId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      select: { id: true },
    });
    return task ? { sessionId: run.sessionId, jobId: null, startedAt: startedAt.toISOString() } : null;
  }

  /**
   * The run that ended last, and how: what the status line's View run opens — the session of a run a maintenance
   * session made, or the row on Activity of a run the server's job made (`jobId`, which has no session).
   */
  private async lastRun(ownerId: string, spaceId: string): Promise<WikiMaintenanceHealth['lastRun']> {
    const run = await this.prisma.wikiMaintenanceRun.findFirst({
      where: { ownerId, spaceId, endedAt: { not: null } },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      select: { sessionId: true, jobId: true, outcome: true, endedAt: true },
    });
    return run?.endedAt
      ? {
        sessionId: run.sessionId,
        jobId: run.jobId,
        outcome: (run.outcome as WikiCursorOutcome | null) ?? null,
        endedAt: run.endedAt.toISOString(),
      }
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
      select: { sessionId: true, jobId: true, failureKind: true, error: true, endedAt: true },
    });
    return run?.endedAt
      ? {
        kind: run.failureKind === 'infra' ? 'infra' : ('content' as WikiMaintenanceFailureKind),
        reason: run.error,
        at: run.endedAt.toISOString(),
        sessionId: run.sessionId,
        jobId: run.jobId,
      }
      : null;
  }
}
