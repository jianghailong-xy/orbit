import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, ProjectStatus, TaskStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { SessionsService } from '../sessions/sessions.service';
import { isLockNotAvailable } from '../tasks/task-supersession';
import { COORDINATOR_PAUSE_SELECT, conversationIsPaused } from './coordinator-evidence-queue';
import {
  EVIDENCE_UNDECIDED_KIND,
  EVIDENCE_UNDECIDED_TITLE,
  type EvidenceUndecidedRoute,
  evidenceUndecidedDedupeKey,
} from './evidence-undecided';
import { type PendingItem, type PendingReadWithEvidence, readPendingWithEvidence } from './pending-addressees';
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
 * Every unanswered latest revision is read on its own as well (`readPendingWithEvidence`), not only
 * as its task's one pending item: an open exception item about the task hides it there, and that is
 * how M2's undecidable revision sat 33 hours with nobody told (2026-11-12, project 34xLkkpjrrFbUzGhsgy7f).
 *
 * ONE CLOCK, FOR EVIDENCE ONLY (project 34xLkkpjrrFbUzGhsgy7f, criterion 34qvp8SfHnGfeJ34xvuOWw).
 * A revision nobody can decide, or that was handed to nobody, is still unanswered the project's
 * `exceptionEscalationSeconds` after the first notice about it (this sweep's report, or the shared
 * undecidable path's turn, `tellEvidenceUndecidable`): the account owner gets one `EVIDENCE_UNDECIDED`
 * item on their Needs-you list (`evidence-undecided.ts`, the owner channel the escalation tick already
 * uses, keyed the same `EV:<evidenceId>`, so the two never open two) and its push. A revision a
 * coordinator holds and can decide is not on this clock: it keeps the evidence queue's rule (§5).
 * Nothing else here waits for a deadline or counts down.
 */

/** How often the sweep runs; the reconcile tick it rides is a minute. */
export const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;

/** How long opening an owner item waits for a lock a door holds before leaving it to the next pass. */
export const EVIDENCE_ESCALATION_LOCK_TIMEOUT_MS = 2_000;

/** One `EVIDENCE_UNDECIDED` item the sweep opened for the owner. */
export interface EvidenceEscalation {
  projectId: string;
  itemId: string;
  taskId: string;
  evidenceId: string;
  route: EvidenceUndecidedRoute;
  /** The first notice about the revision, from which the window ran. */
  noticeAt: Date;
}

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

  /**
   * One project's orphans, each reported unless it already was, then its evidence that waited out the
   * window after its notice escalated to the owner (`escalateEvidence`). Returns the reports written now.
   */
  async sweepProject(ownerId: string, projectId: string, readAt: Date = new Date()): Promise<OrphanReport[]> {
    const pending = await readPendingWithEvidence(this.prisma, ownerId, projectId, readAt);
    if (!pending) return [];
    const reports = await this.reportOrphans(ownerId, projectId, pending);
    try {
      await this.escalateEvidence(ownerId, projectId, pending);
    } catch (error) {
      this.logger.warn(`evidence escalation of project ${projectId} failed: ${error instanceof Error ? error.message : error}`);
    }
    return reports;
  }

  private async reportOrphans(ownerId: string, projectId: string, pending: PendingReadWithEvidence): Promise<OrphanReport[]> {
    const groups = new Map<string, PendingItem[]>();
    for (const item of pending.read.items.filter((candidate) => candidate.orphan)) {
      groups.set(item.orphanKey, [...(groups.get(item.orphanKey) ?? []), item]);
    }
    // A revision hidden behind its task's exception item is reported on its own.
    for (const { item } of pending.evidence) {
      if (item.orphan && !groups.has(item.orphanKey)) groups.set(item.orphanKey, [item]);
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
        taskId: root.taskId,
        sessionId: root.kind === 'TASK_RUN' ? root.subjectId : null,
      });
    }
    return reports;
  }

  /**
   * The clock (header): each unanswered revision that cannot be decided, or that nobody was handed,
   * whose first notice is the project's `exceptionEscalationSeconds` old, gets the owner's
   * `EVIDENCE_UNDECIDED` item, once per revision whatever opened it. Not on it: a revision whose
   * addressee is the owner already (their evidence card or Restart row), and a decidable one a
   * coordinator was handed (the evidence queue's rule). The window is read at the sweep's `readAt`.
   */
  async escalateEvidence(ownerId: string, projectId: string, pending: PendingReadWithEvidence): Promise<EvidenceEscalation[]> {
    const candidates = pending.evidence.filter(({ item, undecidableReason }) => (
      item.addressee !== null && item.addressee.kind !== 'OWNER'
      && (undecidableReason !== null || item.notifiedAt === null)
    ));
    if (candidates.length === 0) return [];
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { exceptionEscalationSeconds: true, coordinatorSessionId: true },
    });
    if (!project) return [];
    const reported = await this.prisma.projectOrphanNotice.findMany({
      where: {
        projectId,
        OR: candidates.map(({ item }) => ({ orphanKey: { startsWith: `EVIDENCE:${item.subjectId}:` } })),
      },
      select: { orphanKey: true, createdAt: true },
    });
    const opened: EvidenceEscalation[] = [];
    for (const { item, undecidableReason } of candidates) {
      const times = [
        ...reported.filter((row) => row.orphanKey.startsWith(`EVIDENCE:${item.subjectId}:`)).map((row) => row.createdAt.getTime()),
        // The shared undecidable path's turn to the run or the coordinator is a notice too.
        ...(undecidableReason !== null && item.notifiedAt ? [item.notifiedAt.getTime()] : []),
      ];
      if (times.length === 0) continue;
      const noticeAt = new Date(Math.min(...times));
      if (pending.read.readAt.getTime() < noticeAt.getTime() + project.exceptionEscalationSeconds * 1_000) continue;
      const route: EvidenceUndecidedRoute = undecidableReason !== null ? 'UNDECIDABLE' : 'UNDELIVERED';
      const itemId = await this.openEvidenceItem(ownerId, projectId, item, {
        route,
        reason: undecidableReason,
        noticeAt,
        windowSeconds: project.exceptionEscalationSeconds,
        coordinatorSessionId: project.coordinatorSessionId,
      });
      if (!itemId) continue;
      this.logger.warn(`opened ${EVIDENCE_UNDECIDED_KIND} ${itemId} of project ${projectId}: `
        + `evidence ${item.subjectId} (${route}) waited out the window after its notice`);
      void this.push?.notifyOwnerItem(itemId).catch((error: unknown) => {
        this.logger.warn(`push for ${EVIDENCE_UNDECIDED_KIND} ${itemId} failed: ${error instanceof Error ? error.message : error}`);
      });
      opened.push({ projectId, itemId, taskId: item.taskId, evidenceId: item.subjectId, route, noticeAt });
    }
    return opened;
  }

  /**
   * One owner item for one revision, unless one was ever opened for it (any state) or the revision is
   * no longer its task's unanswered latest. Under a short lock timeout: a task a door holds is the next
   * pass's. Null when nothing was written.
   */
  private async openEvidenceItem(
    ownerId: string,
    projectId: string,
    item: PendingItem,
    facts: {
      route: EvidenceUndecidedRoute;
      reason: string | null;
      noticeAt: Date;
      windowSeconds: number;
      coordinatorSessionId: string | null;
    },
  ): Promise<string | null> {
    const dedupeKey = evidenceUndecidedDedupeKey(item.subjectId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${EVIDENCE_ESCALATION_LOCK_TIMEOUT_MS}ms`}, true)`;
        if (await tx.projectOpenItem.findFirst({ where: { projectId, dedupeKey }, select: { id: true } })) return null;
        const evidence = await tx.taskCompletionEvidence.findFirst({
          where: {
            id: item.subjectId,
            taskId: item.taskId,
            decisions: { none: {} },
            task: {
              ownerId,
              projectId,
              completionCriterion: 'EVIDENCE_JUDGMENT',
              status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
            },
          },
          select: { revision: true, submittedAt: true, sourceSessionId: true, task: { select: { title: true } } },
        });
        if (!evidence) return null;
        const newer = await tx.taskCompletionEvidence.findFirst({
          where: { taskId: item.taskId, revision: { gt: evidence.revision } },
          select: { id: true },
        });
        if (newer) return null;
        const now = new Date();
        const created = await tx.projectOpenItem.create({
          data: {
            projectId,
            ownerId,
            kind: EVIDENCE_UNDECIDED_KIND,
            assignee: 'OWNER',
            assigneeReason: 'ESCALATED',
            taskId: item.taskId,
            sessionId: evidence.sourceSessionId,
            dedupeKey,
            title: `${EVIDENCE_UNDECIDED_TITLE}: ${evidence.task.title}`,
            payload: {
              evidenceId: item.subjectId,
              revision: evidence.revision.toString(),
              submittedAt: evidence.submittedAt.toISOString(),
              windowSeconds: facts.windowSeconds,
              coordinatorSessionId: facts.coordinatorSessionId,
              route: facts.route,
              reason: facts.reason,
              noticeAt: facts.noticeAt.toISOString(),
            },
            waitingSince: evidence.submittedAt,
            assignedAt: now,
            escalatedAt: now,
          },
          select: { id: true },
        });
        return created.id;
      });
    } catch (error) {
      // Opened by another pass in the meantime (the partial unique key over OPEN items), or a lock a
      // door holds: either way nothing was written now, and the next pass reads committed rows again.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      if (isLockNotAvailable(error)) return null;
      throw error;
    }
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
