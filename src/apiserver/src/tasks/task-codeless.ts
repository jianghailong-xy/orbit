import type { Prisma } from '@prisma/client';

import { sessionReportedWork } from '../projects/landing-source-branch';

/**
 * Turning an existing task `codeless` (SR5's escape hatch, migration 0231).
 *
 * Since contract revision 42 (§12.15 P-M3) the flag no longer decides landing: Orbit measures
 * whether work lands from its commits. What it does is shape the run: a codeless task resolves no
 * source and its run gets a checkout with no branch until it has something to commit.
 *
 * Declaring it when the task is CREATED is the first statement of what the task is, and costs
 * nothing. Declaring it LATER needs:
 *
 *  - a reason, stored on the row beside the declaration (`task.codeless_reason`, 0346), because a
 *    later reader is owed why the task was declared to produce no code; and
 *  - the task having no commits of its own: a task with commits has work that lands the ordinary
 *    way, so the declaration is refused for it.
 *
 * Only the change is questioned, in one direction. Re-sending `codeless: true` to a task that is
 * already codeless changes nothing, and taking the declaration back needs no reason.
 */

export const MAX_TASK_CODELESS_REASON_CHARS = 2_000;

export const TASK_CODELESS_REASON_REQUIRED_CODE = 'TASK_CODELESS_REASON_REQUIRED';
export const TASK_CODELESS_HAS_COMMITS_CODE = 'TASK_CODELESS_HAS_COMMITS';

/** One fact saying this task has commits of its own. */
export interface TaskCommitEvidence {
  /** A merge receipt that MOVED a target with this task's work, or a work session whose finalize
   *  reported changes on its branch (`changed_files`, the column `landing-source-branch.ts` reads
   *  for exactly this question). */
  kind: 'MERGE_MOVED_A_TARGET' | 'SESSION_REPORTED_WORK';
  /** The branch the fact is about: the receipt's source, or the session's. */
  branch: string;
}

/** A blank reason is no reason: trimmed, and null when nothing is left. */
export function normaliseCodelessReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Every fact this repository holds that says the task has commits of its own, newest work first.
 *
 * Two, and they are the two the landing lane itself stands on. `MERGED` is the receipt result that
 * means a target CHANGED (`ALREADY_MERGED` is the line's word for nothing moving, and is what a
 * zero-commit task's NOTHING_TO_LAND writes), whoever recorded it — the line's own landing or an
 * agent's merge of its own branch. And a work session that ran a branch and reported changes on it
 * when it finished: the runner commits a worktree when it finishes the session, so changes it
 * reported are commits on that branch, or about to be. A session that never reported anything is no
 * work, as everywhere else this question is asked.
 */
export async function readTaskCommitEvidence(
  db: Pick<Prisma.TransactionClient, 'sessionMergeReceipt' | 'session'>,
  taskId: string,
): Promise<TaskCommitEvidence[]> {
  const [merges, sessions] = await Promise.all([
    db.sessionMergeReceipt.findMany({
      where: { taskId, result: 'MERGED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
      select: { sourceBranch: true },
    }),
    db.session.findMany({
      where: {
        taskId,
        startsTaskWork: true,
        deletedAt: null,
        isolationStatus: 'worktree',
        branch: { not: null },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { branch: true, changedFiles: true },
    }),
  ]);
  return [
    ...sessions.filter(sessionReportedWork)
      .map((session) => ({ kind: 'SESSION_REPORTED_WORK' as const, branch: session.branch as string })),
    ...merges.map((receipt) => ({ kind: 'MERGE_MOVED_A_TARGET' as const, branch: receipt.sourceBranch })),
  ];
}

/** The refusal for a declaration with no reason, in the shape the doors beside it answer with. */
export function taskCodelessReasonRequiredBody() {
  return {
    code: TASK_CODELESS_REASON_REQUIRED_CODE,
    kind: 'REFUSAL',
    requiredAction: 'EXPLAIN_WHY_THE_TASK_NEEDS_NO_CODE',
    reasonField: 'codelessReason',
    message:
      'Declaring an existing task codeless means it resolves no source and its run gets a checkout ' +
      'with no branch until it has something to commit. It does not decide landing: Orbit measures ' +
      'that from commits. Send a non-blank codelessReason in the ' +
      'same request — why this work produces no code — and it is stored on the task beside the ' +
      'declaration. Declaring codeless when a task is created needs none, and neither does ' +
      're-sending it to a task that already is.',
  } as const;
}

/** The refusal for a task that already has commits of its own. Names what says so. */
export function taskCodelessHasCommitsBody(evidence: readonly TaskCommitEvidence[]) {
  const said = evidence.map((item) => (item.kind === 'MERGE_MOVED_A_TARGET'
    ? `a merge of ${item.branch} moved its target`
    : `a work session reported changes on ${item.branch}`));
  return {
    code: TASK_CODELESS_HAS_COMMITS_CODE,
    kind: 'REFUSAL',
    requiredAction: 'LAND_ITS_COMMITS_INSTEAD',
    evidence: [...evidence],
    message:
      `This task already has commits of its own (${[...new Set(said)].join('; ')}), so it cannot ` +
      'be declared codeless: codeless no longer decides landing, which is measured from commits, and ' +
      'its commits land the ordinary way. If part of what it covers really produces no ' +
      'code, file that part as a task of its own and declare it codeless when you create it.',
  } as const;
}
