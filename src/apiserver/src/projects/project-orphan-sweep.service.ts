import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ProjectStatus, TaskStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SessionsService } from '../sessions/sessions.service';
import { COORDINATOR_PAUSE_SELECT, conversationIsPaused } from './coordinator-evidence-queue';
import { type PendingItem, readPendingAddressees } from './pending-addressees';
import { derivedUuid } from './project-dispatch-identity';
import { conversationIsOver } from './project-open-item';

/**
 * THE ORPHAN SWEEP (docs/evidence-always-has-an-addressee-design.md §4, owner decision D3 = A).
 *
 * The backstop under every path that is meant to tell somebody about a pending item: periodically,
 * each open, unpaused project's pending items are read (`readPendingAddressees`), and every ORPHAN —
 * an item nobody can move, or whose addressee was never told — is reported ONCE:
 *
 *   * to the project's coordinator conversation, as one platform turn, when the project is Automatic
 *     and that conversation has not ended (one that is paused is not written to: what it would be told
 *     waits for it, as everything owed to it does);
 *   * otherwise to the account owner, as one push.
 *
 * "Once" is the ledger (`project_orphan_notice`, migration 0585): one row per (project, orphan key),
 * and the key names the item and the state it is in, so the same orphan in the same state is never
 * reported again, and a state that changes and goes wrong again is a new key. Dependents waiting
 * behind an orphan share its key and are named in its one report. The coordinator's turn is keyed by
 * the same pair, so a sweep cut off between the turn and its ledger row writes the turn's replay,
 * not a second message.
 *
 * No clock and no card: nothing here waits for a deadline, escalates, or counts down. It reports what
 * it finds and changes no rule about who decides what or when (§5, evidence-waits-for-coordinator).
 */

/** How often the sweep runs; the reconcile tick it rides is a minute. */
export const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface OrphanReport {
  projectId: string;
  orphanKey: string;
  recipient: 'COORDINATOR' | 'OWNER';
  sessionId: string | null;
  /** The orphan the report is about, and the tasks waiting behind it. */
  taskIds: string[];
}

function describe(item: PendingItem): string {
  if (item.addressee === null) return 'Nobody can move it now.';
  if (item.addressee.kind === 'COORDINATOR') return 'It is the coordinator\'s to move, and it was never handed to the coordinator.';
  if (item.addressee.kind === 'RUN') {
    return `It is for the task's running session ${uuidToBase62(item.addressee.sessionId!)} to move, and that session was never told.`;
  }
  return 'It was never put in front of the one who can move it.';
}

/** The one message an orphan is reported in, with the tasks waiting behind it. */
export function orphanMessage(root: PendingItem, waiting: readonly PendingItem[]): string {
  const behind = waiting.length === 0
    ? ''
    : `\nWaiting behind it: ${waiting.map((item) => `“${item.title}” (${uuidToBase62(item.taskId)})`).join(', ')}.`;
  return (
    `[Nobody has this: a pending item of task “${root.title}”]\n\n`
    + `${root.detail}\n${describe(root)}${behind}\n`
    + `What would move it: ${root.needed}\n\n`
    + 'This is the orphan sweep\'s one notice about this item in this state: it is not repeated while nothing changes, '
    + 'and it starts no clock. Go by the state you read now; it may have moved since this was written.'
  );
}

@Injectable()
export class ProjectOrphanSweepService {
  private readonly logger = new Logger(ProjectOrphanSweepService.name);
  private lastSweepAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    @Optional() private readonly push?: PushService,
  ) {}

  /** The reconcile tick's call: a sweep at most every `ORPHAN_SWEEP_INTERVAL_MS`. Never rejects. */
  async tick(now: Date = new Date()): Promise<void> {
    if (now.getTime() - this.lastSweepAt < ORPHAN_SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now.getTime();
    try {
      await this.sweep(now);
    } catch (error) {
      this.logger.error(`orphan sweep failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Every open, unpaused project with an unfinished task. */
  async sweep(readAt: Date = new Date()): Promise<OrphanReport[]> {
    const projects = await this.prisma.project.findMany({
      where: {
        status: ProjectStatus.OPEN,
        pausedAt: null,
        tasks: { some: { status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.FAILED] } } },
      },
      select: { id: true, ownerId: true },
      orderBy: { id: 'asc' },
    });
    const reports: OrphanReport[] = [];
    for (const project of projects) {
      try {
        reports.push(...await this.sweepProject(project.ownerId, project.id, readAt));
      } catch (error) {
        this.logger.warn(`orphan sweep of project ${project.id} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    return reports;
  }

  /** One project's orphans, each reported unless it already was. Returns the reports written now. */
  async sweepProject(ownerId: string, projectId: string, readAt: Date = new Date()): Promise<OrphanReport[]> {
    const read = await readPendingAddressees(this.prisma, ownerId, projectId, readAt);
    if (!read) return [];
    const groups = new Map<string, PendingItem[]>();
    for (const item of read.items.filter((candidate) => candidate.orphan)) {
      groups.set(item.orphanKey, [...(groups.get(item.orphanKey) ?? []), item]);
    }
    if (groups.size === 0) return [];
    const reported = new Set((await this.prisma.projectOrphanNotice.findMany({
      where: { projectId, orphanKey: { in: [...groups.keys()] } },
      select: { orphanKey: true },
    })).map((row) => row.orphanKey));
    const fresh = [...groups.entries()].filter(([key]) => !reported.has(key));
    if (fresh.length === 0) return [];

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { title: true, coordinatorEnabled: true, coordinatorSession: { select: { id: true, ...COORDINATOR_PAUSE_SELECT } } },
    });
    if (!project) return [];
    const coordinator = project.coordinatorEnabled && project.coordinatorSession
      && !conversationIsOver(project.coordinatorSession)
      ? project.coordinatorSession
      : null;
    // A paused coordinator is still the one to tell; it is told when it is back, by a later pass.
    if (coordinator && conversationIsPaused(coordinator)) return [];

    const reports: OrphanReport[] = [];
    for (const [orphanKey, items] of fresh) {
      const root = items.find((item) => item.kind !== 'DEPENDENCIES') ?? items[0]!;
      const waiting = items.filter((item) => item !== root);
      const content = orphanMessage(root, waiting);
      const noticeId = derivedUuid(`project-orphan:v1:${projectId}:${orphanKey}`);
      const row = {
        projectId,
        ownerId,
        taskId: root.taskId,
        orphanKey,
        kind: root.kind,
      };
      if (coordinator) {
        if (!await this.tell(ownerId, coordinator.id, noticeId, content)) continue;
        await this.prisma.projectOrphanNotice.createMany({
          data: [{ ...row, recipient: 'COORDINATOR', sessionId: coordinator.id, clientTurnId: noticeId }],
          skipDuplicates: true,
        });
        reports.push({ projectId, orphanKey, recipient: 'COORDINATOR', sessionId: coordinator.id, taskIds: items.map((item) => item.taskId) });
        continue;
      }
      const written = await this.prisma.projectOrphanNotice.createMany({
        data: [{ ...row, recipient: 'OWNER' }],
        skipDuplicates: true,
      });
      if (written.count === 0) continue;
      reports.push({ projectId, orphanKey, recipient: 'OWNER', sessionId: null, taskIds: items.map((item) => item.taskId) });
      void this.push?.notifyProjectOrphan({
        ownerId,
        projectId,
        noticeId,
        title: `${project.title}: nobody has this`,
        body: `${root.detail} ${describe(root)}`,
      });
    }
    return reports;
  }

  /** One platform turn on the coordinator's conversation. False when it was not written. */
  private async tell(ownerId: string, sessionId: string, clientTurnId: string, content: string): Promise<boolean> {
    try {
      await this.sessions.createTurn(ownerId, sessionId, { clientTurnId, content, intent: 'NEXT_TURN' });
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundException
        || error instanceof ConflictException
        || error instanceof ForbiddenException
        || error instanceof BadRequestException
      ) {
        this.logger.log(`orphan notice to session ${sessionId} was not written: ${error.message}`);
        return false;
      }
      this.logger.warn(`orphan notice to session ${sessionId} failed: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }
}
