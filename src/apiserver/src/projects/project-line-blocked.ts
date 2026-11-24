import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { baselineHoldSql } from './baseline-hold';
import { lineSyncHoldSql } from './line-sync-hold';
import { lineBlockedFact, type WakeFact } from './coordinator-wake';
import { findIdleRuns } from './task-run-idle';

/**
 * A BLOCKED PROJECT LINE: an open integration item holds other tasks' queued landings, and the run that
 * has to act on it sits idle.
 *
 * WHY
 * ===
 * In project "Session translation" (34vcDOhN0OCStfnVuTyPq), MAIN_SYNC item 34wS12mhpciMYkJI52eE1 held
 * the queued landings of four other tasks from 2026-11-12/13 until at least 2026-11-14. The item was
 * the coordinator's, the coordinator had reopened the conflicted task for a merge-only round, and that
 * run parked. Nothing has a timeout here on purpose (M2: the item is the retry mechanism), and the
 * open-item clock hands nothing to the owner once a live coordinator took the item up, so nobody was
 * told the whole line had stopped.
 *
 * THE RULE (thresholds agreed with the owner on 2026-11-14, project 34xLkkpjrrFbUzGhsgy7f)
 * ========
 *  - A line is held when an OPEN item holds another task's QUEUED landing on its serial key, by the
 *    claim's own two holds: M2 (an `INTEGRATION_CONFLICT` at `MAIN_SYNC`, except a fix task's landing)
 *    and K4 (`baselineHoldSql`, a baseline-red check failure).
 *  - The run that must act is the run of the item's task, or of a task filed to fix the item
 *    (`fixes_open_item_id`). It is idle by T3's check (`findIdleRuns`), with this threshold instead of
 *    the idle-run one. The line-sync item names no task: until a sync task is filed against it, the
 *    item having waited past the threshold with none filed counts as idle (T5b).
 *  - When both have held for longer than `LINE_BLOCKED_THRESHOLD_MS`, the coordinator gets one
 *    `TASK_RUN_STOPPED` notice per item and idle period (`lineBlockedFact`).
 *  - The project's `exceptionEscalationSeconds` after the first such notice about an item, if the item
 *    still holds the line, the account owner is told once, whatever the coordinator did with it
 *    meanwhile (`ProjectLineBlockedService`).
 */
export const LINE_BLOCKED_THRESHOLD_MS = 60 * 60_000;

/** The owner's ledger key for a blocked line (`project_orphan_notice`): one push per item. */
export function lineBlockedOwnerKey(itemId: string): string {
  return `blocked-line:${itemId}`;
}

/** The part of a notice's `subjectVersion` that names the item, for finding the first notice. */
export function lineBlockedVersionMarker(itemId: string): string {
  return `:line:${itemId}:`;
}

/** One open item holding other tasks' queued landings. */
export interface HeldLine {
  itemId: string;
  projectId: string;
  ownerId: string;
  projectTitle: string;
  itemTitle: string;
  itemTaskId: string | null;
  /** When the item began waiting, or the oldest landing it holds was queued, whichever is later. */
  heldSince: Date;
  /** The tasks whose landings it holds. */
  held: Array<{ taskId: string; title: string }>;
  escalationSeconds: number;
  /**
   * The line-sync item (docs/design/project-line-upstream-sync.md §4.1): it names no task, and the run that must act
   * on it is that of the sync task the coordinator files from it. Until one is filed, nobody's run is working on it.
   */
  lineSync: boolean;
  /** When the item began waiting. */
  waitingSince: Date;
  /** The job that found the conflict: its task and session, which a notice about a task-less item is keyed on. */
  conflict: { taskId: string | null; taskTitle: string | null; sessionId: string | null };
}

interface HeldLineRow {
  itemId: string;
  projectId: string;
  ownerId: string;
  projectTitle: string;
  itemTitle: string;
  itemTaskId: string | null;
  waitingSince: Date;
  oldestHeldAt: Date;
  held: Array<{ taskId: string; title: string }>;
  escalationSeconds: number;
  lineSync: boolean;
  conflictTaskId: string | null;
  conflictTaskTitle: string | null;
  conflictSessionId: string | null;
}

/** Every OPEN item of an open project that holds another task's queued landing now. Reads only. */
export async function findHeldLines(prisma: PrismaService, filter: { itemId?: string } = {}): Promise<HeldLine[]> {
  const rows = await prisma.$queryRaw<HeldLineRow[]>(Prisma.sql`
    SELECT i."id" AS "itemId", i."project_id" AS "projectId", i."owner_id" AS "ownerId",
           p."title" AS "projectTitle", i."title" AS "itemTitle", i."task_id" AS "itemTaskId",
           i."waiting_since" AS "waitingSince", p."exception_escalation_seconds" AS "escalationSeconds",
           i."dedupe_key" = 'IMS:' || f."serial_key" AS "lineSync",
           f."task_id" AS "conflictTaskId", conflict_task."title" AS "conflictTaskTitle",
           f."session_id" AS "conflictSessionId",
           min(held."created_at") AS "oldestHeldAt",
           COALESCE(jsonb_agg(DISTINCT jsonb_build_object('taskId', held_task."id", 'title', held_task."title"))
                      FILTER (WHERE held_task."id" IS NOT NULL), '[]'::jsonb) AS "held"
      FROM "project_open_item" i
      JOIN "project" p ON p."id" = i."project_id" AND p."status" = 'OPEN'
      JOIN "project_integration_job" f ON f."id" = i."integration_job_id"
      JOIN "project_integration_job" held
        ON held."state" = 'QUEUED'
       AND held."serial_key" = f."serial_key"
       AND (
         -- M2, as the claim reads it: the line-sync item holds the conflicted task's own held generation too.
         (${lineSyncHoldSql('held')})
         -- K4.
         OR (held."task_id" IS DISTINCT FROM f."task_id" AND ${baselineHoldSql('held')}))
      LEFT JOIN "task" held_task ON held_task."id" = held."task_id"
      LEFT JOIN "task" conflict_task ON conflict_task."id" = f."task_id"
     WHERE i."state" = 'OPEN'
       AND i."kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED')
       ${filter.itemId ? Prisma.sql`AND i."id" = ${filter.itemId}::uuid` : Prisma.empty}
     GROUP BY i."id", p."id", f."id", conflict_task."id"
     ORDER BY i."created_at", i."id"`);
  return rows.map((row) => ({
    itemId: row.itemId,
    projectId: row.projectId,
    ownerId: row.ownerId,
    projectTitle: row.projectTitle,
    itemTitle: row.itemTitle,
    itemTaskId: row.itemTaskId,
    heldSince: new Date(Math.max(row.waitingSince.getTime(), row.oldestHeldAt.getTime())),
    held: row.held,
    escalationSeconds: row.escalationSeconds,
    lineSync: row.lineSync,
    waitingSince: row.waitingSince,
    conflict: { taskId: row.conflictTaskId, taskTitle: row.conflictTaskTitle, sessionId: row.conflictSessionId },
  }));
}

/**
 * The coordinator notices owed as of `now`: one per held line whose acting run has been idle, and the
 * line held, for longer than the threshold. Reads only; `now` is a parameter so a spec moves the clock.
 */
export async function findBlockedLineFacts(
  prisma: PrismaService,
  now: Date,
  filter: { itemId?: string } = {},
): Promise<WakeFact[]> {
  const facts: WakeFact[] = [];
  for (const line of await findHeldLines(prisma, filter)) {
    if (now.getTime() - line.heldSince.getTime() <= LINE_BLOCKED_THRESHOLD_MS) continue;
    const fixes = await prisma.task.findMany({ where: { fixesOpenItemId: line.itemId }, select: { id: true } });
    const actors = [...new Set([line.itemTaskId, ...fixes.map((task) => task.id)].filter((id): id is string => !!id))];
    // The line-sync item before any sync task is filed against it: no run exists to go idle, so "no sync task filed
    // for longer than the threshold" is the idle period, counted from when the item began waiting. The notice is
    // keyed on the job that found the conflict (its task and session), once per item.
    if (actors.length === 0 && line.lineSync && line.conflict.taskId && line.conflict.sessionId) {
      facts.push(lineBlockedFact({
        projectId: line.projectId,
        taskId: line.conflict.taskId,
        taskTitle: line.conflict.taskTitle ?? '',
        sessionId: line.conflict.sessionId,
        idleSince: line.waitingSince,
        lastProgress: null,
        lastWords: null,
        awaitingSyncTask: true,
      }, line));
      continue;
    }
    for (const taskId of actors) {
      for (const run of await findIdleRuns(prisma, now, { taskId }, LINE_BLOCKED_THRESHOLD_MS)) {
        facts.push(lineBlockedFact({ ...run, projectId: line.projectId }, line));
      }
    }
  }
  return facts;
}

/** The notice under this `subjectVersion` if it is still owed as of `now`: what the fact queue re-sends. */
export async function blockedLineFactFor(prisma: PrismaService, subjectVersion: string, now: Date): Promise<WakeFact | null> {
  const itemId = /:line:([0-9a-f-]{36}):/i.exec(subjectVersion)?.[1];
  if (!itemId) return null;
  return (await findBlockedLineFacts(prisma, now, { itemId })).find((fact) => fact.subjectVersion === subjectVersion) ?? null;
}
