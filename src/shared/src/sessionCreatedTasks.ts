/**
 * What the "Tasks created here" row above a session's composer is drawn from:
 * `GET /api/sessions/:id/created-tasks?limit=`, and the sentence both clients write about it.
 *
 * `Instant` is the one thing that differs across the wire, as in `link-preview.ts`: the apiserver
 * holds these as `Date`, everything downstream of JSON as ISO strings. Every id is the base62
 * public id.
 *
 * A ROW is not quite a task. Each task the session created (`task.creatorSessionId`) is one row,
 * except that a task another one took over — `terminalReason = 'SUPERSEDED'` with a successor — is
 * drawn as the end of that chain, the attempt actually doing the work, with `replaces` naming the
 * task this session created. Several of the session's tasks taken over by the same successor are
 * one row. So a failure that was retried elsewhere is not drawn as a red Failed, and every count
 * here counts rows, which is what keeps the pills and the sentence in agreement.
 */
import type { TaskStatus } from './enums';

/** How many rows `items` carries when the request names no `limit`, and the most it may name. */
export const SESSION_CREATED_TASKS_DEFAULT_LIMIT = 20;
export const SESSION_CREATED_TASKS_MAX_LIMIT = 50;

export interface SessionCreatedTaskRow<Instant = string> {
  /** The task the row draws: the one this session created, or the end of its supersession chain. */
  id: string;
  title: string;
  status: `${TaskStatus}`;
  /** The task list's live overlays: a RUNNING session on it, or a PENDING one with none running. */
  running: boolean;
  queued: boolean;
  createdAt: Instant;
  projectId: string | null;
  /** The task this session created that the row's task took over; null when the row IS that task. */
  replaces: { id: string; title: string } | null;
}

export interface SessionCreatedTasks<Instant = string> {
  /** Every row, whatever `limit` was. */
  total: number;
  /** Rows whose `running` is true. */
  running: number;
  /** Rows whose status is FAILED. */
  failed: number;
  /** Rows whose status is DONE. */
  done: number;
  /**
   * The first `limit` rows: Failed, Running, Queued, the rest of the unfinished (Open, In
   * progress), Done, Cancelled, and newest first within each. A row sorts under the pill it shows,
   * so a running or queued task is under Running or Queued whatever its status says.
   */
  items: SessionCreatedTaskRow<Instant>[];
  /** The projects `items` belong to, each once, in the order `items` first names them. */
  projects: { id: string; title: string }[];
}

/** The four numbers the row's sentence is made of. */
export type SessionCreatedTaskCounts = Pick<SessionCreatedTasks, 'running' | 'failed' | 'done' | 'total'>;

/** The row's fixed words; `session-created-tasks.fixture.json` carries the same for both clients. */
export const SESSION_CREATED_TASKS_COPY = {
  title: 'Tasks created here',
  viewAll: 'View all in Tasks ›',
  openProject: 'Open project ›',
  replacesPrefix: 'Replaces ',
  createdInChip: 'Created in ',
} as const;

/**
 * The collapsed row's sentence: `N running`, `N failed` and `done/total done`, joined by ` · `. A
 * zero running or failed is left out rather than written as `0 running`; `done/total` always stays,
 * so the sentence is never empty.
 *
 * With exactly one row the collapsed row writes no sentence at all — it names the task and shows
 * its pill, as the Watching row does (`singleNamesTheTask` in the fixture). That is the client's
 * choice to make; this function answers for any count.
 */
export function createdTasksCountLine(counts: SessionCreatedTaskCounts): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  parts.push(`${counts.done}/${counts.total} done`);
  return parts.join(' · ');
}
