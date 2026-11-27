import { Prisma, TaskStatus } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { turnStateFilter } from '../sessions/session-turn-state';
import { sessionWakeSourceSql } from '../sessions/task-work-carrier';
import { SESSION_ENDING_SELECT, sessionHasEnded } from './project-open-item';
import { runLastWords } from './run-last-words';

/**
 * How long a task run may sit parked (AWAITING_INPUT) with no evidence and no progress before the
 * project's coordinator is told. Agreed with the owner on 2026-11-14 (project 34xLkkpjrrFbUzGhsgy7f).
 */
export const TASK_RUN_IDLE_THRESHOLD_MS = 30 * 60_000;

/** One run that has been idle past the threshold, with what a notice about it names. */
export interface IdleRun {
  projectId: string;
  taskId: string;
  taskTitle: string;
  /** The session to nudge. */
  sessionId: string;
  /** The newest of: the run's last turn, the task's last reported progress, its newest evidence revision. */
  idleSince: Date;
  /** The task's last progress report, as a sentence; null when it never reported one. */
  lastProgress: string | null;
  lastWords: string | null;
}

export interface IdleRunFilter {
  sessionId?: string;
  taskId?: string;
  projectId?: string;
}

function progressText(p: { phase: string | null; current: number | null; total: number | null; message: string | null }): string | null {
  const count = p.current !== null && p.total !== null ? `${p.current}/${p.total}` : null;
  const text = [p.phase, count, p.message].filter((part) => part).join(' · ');
  return text || null;
}

/**
 * The idle-run check. A run is idle when it is an unsettled EVIDENCE_JUDGMENT task's own run, parked
 * with nothing that would wake it (`sessionWakeSourceSql`), no evidence waiting for a decision, and
 * its last activity is more than `thresholdMs` before `now`. Reads only; the clock is a parameter so
 * a spec, and the blocked-line notice that reuses this, choose their own `now`.
 */
export async function findIdleRuns(
  prisma: PrismaService,
  now: Date,
  filter: IdleRunFilter = {},
  thresholdMs: number = TASK_RUN_IDLE_THRESHOLD_MS,
): Promise<IdleRun[]> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const sessions = await prisma.session.findMany({
    where: {
      ...(filter.sessionId ? { id: filter.sessionId } : {}),
      startsTaskWork: true,
      // Parked (plan §2.1: A).
      ...turnStateFilter([null]),
      lastTurnAt: { not: null, lt: cutoff },
      task: {
        ...(filter.taskId ? { id: filter.taskId } : {}),
        projectId: filter.projectId ?? { not: null },
        project: { status: 'OPEN' },
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
        verifiesTaskId: null,
        isForeman: false,
        supersededByTaskId: null,
      },
    },
    select: {
      ...SESSION_ENDING_SELECT,
      id: true,
      lastTurnAt: true,
      lastAssistantText: true,
      task: {
        select: {
          id: true,
          title: true,
          projectId: true,
          progress: { select: { phase: true, current: true, total: true, message: true, lastProgressAt: true } },
          completionEvidence: {
            orderBy: { revision: 'desc' },
            take: 1,
            select: { submittedAt: true, decisions: { select: { id: true }, take: 1 } },
          },
        },
      },
    },
  });

  const idle: IdleRun[] = [];
  for (const run of sessions) {
    const task = run.task;
    if (!task?.projectId || !run.lastTurnAt || sessionHasEnded(run)) continue;
    const [latest] = task.completionEvidence;
    // Evidence nobody has answered is the evidence queue's to deliver, not an idle run.
    if (latest && latest.decisions.length === 0) continue;
    const activity = [run.lastTurnAt, task.progress?.lastProgressAt, latest?.submittedAt]
      .filter((at): at is Date => at instanceof Date);
    const idleSince = new Date(Math.max(...activity.map((at) => at.getTime())));
    if (now.getTime() - idleSince.getTime() <= thresholdMs) continue;

    const [wakeSource] = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s."id" FROM "session" s
       WHERE s."id" = ${run.id}::uuid
         AND ${Prisma.raw(sessionWakeSourceSql('s'))}`);
    if (wakeSource) continue;

    idle.push({
      projectId: task.projectId,
      taskId: task.id,
      taskTitle: task.title,
      sessionId: run.id,
      idleSince,
      lastProgress: task.progress ? progressText(task.progress) : null,
      lastWords: runLastWords(run.lastAssistantText),
    });
  }
  return idle;
}

/** Whether the run of this task that is parked has been idle past the threshold: what T4's blocked-line notice asks. */
export async function isTaskRunIdle(
  prisma: PrismaService,
  taskId: string,
  now: Date,
  thresholdMs: number = TASK_RUN_IDLE_THRESHOLD_MS,
): Promise<boolean> {
  return (await findIdleRuns(prisma, now, { taskId }, thresholdMs)).length > 0;
}
