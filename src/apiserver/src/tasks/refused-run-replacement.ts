import { CreatorType, type Prisma } from '@prisma/client';
import { runNotCounted } from '../common/run-not-counted';
import type { ModelRoutingNotCounted } from './model-routing';

/**
 * Replacing a run its account refused (docs/routing-account-health-design.md §7.3): the rules, apart from the dispatch
 * that carries them out (TasksService.replaceRefusedRun).
 *
 * A task run cannot change engine, so a run the provider turned away before it did any work is replaced by a new run
 * of the task, at once and with no backoff, whether or not the task auto-runs (owner decision Q3): the owner or the
 * sweep asked for the task to run, the run did no work, and it was the router's choice that failed. The new run is a
 * fresh dispatch, so the router reads the health the refusal wrote and goes elsewhere.
 */

/** At most this many replacements per task per hour, refused trials excepted (§7.3). */
export const REPLACEMENTS_PER_HOUR = 3;
export const REPLACEMENT_WINDOW_MS = 60 * 60_000;

/** What §7.4 does not count and §7.3 replaces: the failure was the account's or the provider's, at admission. */
const REPLACED: ReadonlySet<ModelRoutingNotCounted> = new Set(['account', 'admission', 'capacity', 'usage-limit']);

/** The run sources whose task work this dispatch may start again: a schedule's runs are its own pipeline's. */
const REPLACEABLE_SOURCES: ReadonlySet<string> = new Set(['MANUAL', 'TASK_LIST_AUTO', 'PROJECT_COORDINATOR']);

export interface RefusedRun {
  status: string;
  taskId: string | null;
  startsTaskWork: boolean;
  runSource: string | null;
  failureKind: string | null;
  error: string | null;
  accountHealthEffect: string | null;
  admissionFailure: boolean | null;
  /** AutoRetryService is going to resume this very Session: two schedulers reviving one task give it two runs. */
  retryAt: Date | null;
}

/**
 * Whether a released run is replaced, and how it counts: 'REPLACE' against the per-hour bound, 'TRIAL' (a refused
 * trial, §6.5) not against it. Null for everything else, which keeps today's behaviour:
 *
 * - only a task's own work, ended FAILED, from a source this dispatch starts (not a schedule's run);
 * - not counted against the task (§7.4) for a reason that is the account's: a refusal, a breaker strike, a model at
 *   capacity, a spent quota. A lost connection is AutoRetryService's to re-send in place; an ordinary failure counts;
 * - refused at admission: account health acted on the run, or the runner measured that it did no work (§5.2). A
 *   usage limit an hour into the work is a failure of that kind, not a refusal, and is not replaced;
 * - not while AutoRetryService has a retry of the same Session armed.
 */
export function replacementOf(run: RefusedRun): 'REPLACE' | 'TRIAL' | null {
  if (run.status !== 'FAILED' || !run.taskId || !run.startsTaskWork) return null;
  if (run.runSource !== null && !REPLACEABLE_SOURCES.has(run.runSource)) return null;
  if (run.retryAt) return null;
  const notCounted = runNotCounted(run);
  if (!notCounted || !REPLACED.has(notCounted)) return null;
  if (run.accountHealthEffect === null && run.admissionFailure !== true) return null;
  return run.accountHealthEffect === 'TRIAL' ? 'TRIAL' : 'REPLACE';
}

/**
 * Whether the bound leaves room for one more replacement (§7.3), given the starts of the replacements this task had
 * in the last hour that count; and when it next does.
 */
export function replacementRoom(counted: readonly Date[], now: Date): { room: true } | { room: false; until: Date } {
  const since = now.getTime() - REPLACEMENT_WINDOW_MS;
  const inWindow = counted.map((at) => at.getTime()).filter((at) => at > since).sort((a, b) => a - b);
  if (inWindow.length < REPLACEMENTS_PER_HOUR) return { room: true };
  // The window frees a place when the oldest of the last REPLACEMENTS_PER_HOUR ages out of it.
  return { room: false, until: new Date(inWindow[inWindow.length - REPLACEMENTS_PER_HOUR] + REPLACEMENT_WINDOW_MS) };
}

/** What a task that does not auto-run records of its replacement, so its history says why a second run exists. */
export function replacementComment(ordinal: number): string {
  return `**Replaced run ${ordinal}, which its account refused (recorded by Orbit)**\n\n`
    + `The provider turned run ${ordinal} away before it did any work, so Orbit started the task again at once, `
    + 'routed with what the refusal taught it. The refused run is not counted against the task.';
}

/**
 * Write replacementComment on the task's timeline, authored as postRunFailureComment authors its record of a failed
 * run (reclaim-stalled-task.ts): by the task's responsible workspace, else its creator, marked as recorded by Orbit.
 */
export async function postReplacementComment(db: Prisma.TransactionClient, taskId: string, body: string): Promise<void> {
  const task = await db.task.findUnique({ where: { id: taskId }, select: { assigneeId: true, creatorType: true, creatorId: true } });
  if (!task) return;
  // Once per refused run: both ends that report one refusal are answered with the same replacement, and the body
  // names the run it replaced.
  if (await db.taskComment.findFirst({ where: { taskId, body }, select: { id: true } })) return;
  await db.taskComment.create({
    data: {
      taskId,
      authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
      authorId: task.assigneeId ?? task.creatorId,
      body,
      // §13.8: written explicitly by this binary; the comment names nobody (TASK_COMMENT_MENTION_DELIVERY_VERSION).
      mentionDeliveryVersion: 1,
    },
  });
}
