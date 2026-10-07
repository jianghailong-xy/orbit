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
import { toUuid } from './codec';
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
  title: 'Tasks',
  viewAll: 'View all in Tasks ›',
  openProject: 'Open project ›',
  replacesPrefix: 'Replaces ',
  createdInChip: 'Created in ',
  elsewhere: 'elsewhere',
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

/**
 * A task one of this session's live watches waits on, as the card reads it: by the name and the
 * standing the watch carries for it (`WatchTargetView.targetTitle` / `targetStatus`).
 */
export interface SessionWatchedTask {
  id: string;
  title: string;
  /** Null when the watch carries no standing for it. */
  standing: { status: string; running: boolean; queued: boolean } | null;
  /** A watch naming it has gone unchecked (`stripStaleLine`). */
  stale: boolean;
}

/** One row of the card: a created row, a watched task, or both. */
export interface SessionTaskCardRow {
  id: string;
  title: string;
  /** Null for a watched task whose standing nobody could read: no pill. */
  standing: { status: string; running: boolean; queued: boolean } | null;
  /** Null for a task created elsewhere, which writes `elsewhere` in its age's place. */
  createdAt: string | null;
  replaces: { id: string; title: string } | null;
  /** A live watch of this session waits on it: the row carries an eye. */
  watched: boolean;
  /** …and that watch has gone unchecked: the eye is orange. */
  stale: boolean;
}

/** What the session's one Tasks card draws: the tasks it created and the tasks it waits on. */
export interface SessionTaskCard {
  /** Watched rows first, then the rest; within each, created rows as served, then the others. */
  rows: SessionTaskCardRow[];
  /** The sentence's numbers: the created rows' tallies plus the watched tasks created elsewhere. */
  counts: SessionCreatedTaskCounts;
  /** How many rows carry an eye — the header's `👁 N`. */
  watching: number;
  /** Some row's eye is orange. */
  stale: boolean;
}

/** One key for either spelling of an id; anything that is neither is its own key. */
function idKey(id: string): string {
  try {
    return toUuid(id);
  } catch {
    return id;
  }
}

/**
 * The Tasks card: Tasks created here and the tasks this session's watches wait on, one row per
 * task. A watched task the session created marks that row (as its task, or as the task the row
 * replaces); one created elsewhere joins as a row of its own. Null when there is neither.
 *
 * The created rows are only the first `limit` the server sent, so a watched task created here but
 * past that page joins as if created elsewhere; the default page is far above what a session watches.
 */
export function sessionTaskCard(
  created: SessionCreatedTasks | null | undefined,
  watched: readonly SessionWatchedTask[],
): SessionTaskCard | null {
  const byKey = new Map<string, SessionWatchedTask>();
  for (const task of watched) {
    const key = idKey(task.id);
    const seen = byKey.get(key);
    // Two watches over one task: one row, orange if either has gone unchecked.
    byKey.set(key, seen ? { ...seen, stale: seen.stale || task.stale } : task);
  }
  const claimed = new Set<string>();
  const createdRows: SessionTaskCardRow[] = (created?.items ?? []).map((row) => {
    const keys = [idKey(row.id), ...(row.replaces ? [idKey(row.replaces.id)] : [])];
    const hits = keys.filter((key) => byKey.has(key));
    hits.forEach((key) => claimed.add(key));
    return {
      id: row.id,
      title: row.title,
      standing: { status: row.status, running: row.running, queued: row.queued },
      createdAt: row.createdAt,
      replaces: row.replaces,
      watched: hits.length > 0,
      stale: hits.some((key) => byKey.get(key)!.stale),
    };
  });
  const elsewhere: SessionTaskCardRow[] = [...byKey.entries()]
    .filter(([key]) => !claimed.has(key))
    .map(([, task]) => ({
      id: task.id,
      title: task.title,
      standing: task.standing,
      createdAt: null,
      replaces: null,
      watched: true,
      stale: task.stale,
    }));
  const counts = {
    running: created?.running ?? 0,
    failed: created?.failed ?? 0,
    done: created?.done ?? 0,
    total: created?.total ?? 0,
  };
  for (const row of elsewhere) {
    counts.total += 1;
    if (row.standing?.running) counts.running += 1;
    if (row.standing?.status === 'FAILED') counts.failed += 1;
    else if (row.standing?.status === 'DONE') counts.done += 1;
  }
  if (counts.total === 0) return null;
  const rows = [
    ...createdRows.filter((row) => row.watched),
    ...elsewhere,
    ...createdRows.filter((row) => !row.watched),
  ];
  const marked = rows.filter((row) => row.watched);
  return { rows, counts, watching: marked.length, stale: marked.some((row) => row.stale) };
}
