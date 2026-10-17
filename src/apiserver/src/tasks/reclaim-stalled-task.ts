import { CreatorType, Prisma, RunStatus, TaskStatus } from '@prisma/client';

import { TaskFailureHow, recordTaskFailure } from '../projects/project-open-item';

/** Durable task-timeline signal emitted when a reserved L0 turn cannot yield a comparison. */
export const EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE =
  'EXECUTABLE_ACCEPTANCE_UNAVAILABLE';

/** Durable task-timeline signal emitted when a run ended with its work off the branch. */
export const WORK_NOT_ON_BRANCH_SIGNAL_CODE = 'WORK_NOT_ON_BRANCH';

// Sessions that could still be working a task: live (RUNNING/AWAITING_INPUT/
// INTERRUPTED) or queued for a runner slot (PENDING). Mirrors the reaper's LIVE
// set plus PENDING.
export const TASK_OCCUPYING: RunStatus[] = [
  RunStatus.PENDING,
  RunStatus.RUNNING,
  RunStatus.AWAITING_INPUT,
  RunStatus.INTERRUPTED,
];

/**
 * Backstop for a stalled task. When a session ends abnormally (FAILED/CANCELLED),
 * the task its workspace left at IN_PROGRESS would otherwise stay "in progress" forever
 * with nothing actually running — the list shows a perpetual running indicator.
 * Task.status is a workspace-owned label (see TasksService.withRunning), so we only
 * nudge it back: if NO other session for the task is still occupying it, move
 * IN_PROGRESS -> `resetTo` so the abandoned work surfaces. `resetTo` is OPEN for a
 * retryable end (user cancel / runner offline) — back to the actionable pool — or
 * FAILED for a genuine run failure that needs a human. No-op when another session is
 * still live or the task isn't IN_PROGRESS.
 *
 * Call inside the SAME transaction that finalized the session, AFTER the session's
 * status has been flipped to terminal — so the just-ended session is no longer
 * counted as occupying. Returns whether the Task status actually moved, so the caller can publish
 * a post-commit dependent-row invalidation without announcing a no-op or publishing in a retrying
 * transaction.
 *
 * `failure` is how this attempt ended, when it ended badly. Passing it opens the project's exception
 * item for the failure in this same transaction (`projects/project-open-item.ts`, contract §4.3) —
 * the three doors that reclaim a task through here (turn completion, runner finalize, the reaper)
 * therefore cannot record one and forget the other. It is omitted where the ending says nothing
 * about the work: a cancel somebody asked for, or a task nobody's project owns.
 */
export async function reclaimStalledTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  resetTo: TaskStatus = TaskStatus.OPEN,
  failure?: { sessionId: string | null; how: TaskFailureHow; error?: string | null },
): Promise<boolean> {
  const occupied = await tx.session.count({
    where: { taskId, status: { in: TASK_OCCUPYING } },
  });
  if (occupied > 0) return false;
  const changed = await tx.task.updateMany({
    where: { id: taskId, status: 'IN_PROGRESS' },
    data: { status: resetTo },
  });
  if (changed.count > 0 && failure) {
    await recordTaskFailure(tx, {
      taskId,
      sessionId: failure.sessionId,
      how: failure.how,
      error: failure.error,
    });
  }
  return changed.count > 0;
}

/**
 * Record a run failure as a comment on the task, so the failure and its reason surface
 * on the task's own timeline instead of being buried in the session transcript (a run
 * that died on a Claude API/content-filter error otherwise just parks silently). The
 * comment is attributed to the task's assignee workspace — the workspace meant to run it —
 * falling back to the task's creator when there is no assignee.
 *
 * Call from the same transaction that finalizes a task-bound session as FAILED, gated on
 * that finalization actually happening (so one failure -> one comment). Independent of
 * the task's own status, so it also covers a run that died before its workspace ever moved
 * the task to IN_PROGRESS.
 */
export async function postRunFailureComment(
  tx: Prisma.TransactionClient,
  taskId: string,
  reason: string,
): Promise<void> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { assigneeId: true, creatorType: true, creatorId: true },
  });
  if (!task) return;
  await tx.taskComment.create({
    data: {
      taskId,
      authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
      authorId: task.assigneeId ?? task.creatorId,
      body:
        `**Run failed (recorded by Orbit)**\n\nA run session of this task stopped on a run error and did not finish.\n\n` +
        `Reason:\n${reason}\n\nRun this task again to retry.`,
    },
  });
}

/**
 * Record, on the task's own timeline, that the run which just ended could not put its work on its
 * branch — so the work exists only as uncommitted files in a checkout nothing will visit again.
 *
 * This is the one signal that makes "status DONE, acceptance command passed, not one commit on the
 * branch" impossible to hold quietly. Those three are all true together whenever the runner's
 * finalize commit is refused, because the acceptance command runs against the WORKING TREE, where
 * the work is, and passes there whether or not anything was ever committed; the commit that would
 * have captured it comes afterwards, and a stale `index.lock` in the checkout's git dir is enough
 * to refuse it. Until this comment existed the refusal was a line in one runner process's log, the
 * task said DONE, and the absence was found days later by whoever tried to merge the branch.
 *
 * Deliberately a comment and not a status change: the task's declared criterion was satisfied by
 * the run, and re-deciding that here would be this code inventing a criterion of its own. What is
 * missing is the landing, which is the reader's to act on — the ended session's Commit action puts
 * the checkout's work on the branch without a new run.
 *
 * Call from the transaction that finalizes a task-bound session, gated on the finalization actually
 * happening, so one stranded run produces one comment.
 */
export async function postWorkNotOnBranchComment(
  tx: Prisma.TransactionClient,
  taskId: string,
  branch: string | null,
  reason: string,
): Promise<void> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { assigneeId: true, creatorType: true, creatorId: true },
  });
  if (!task) return;
  await tx.taskComment.create({
    data: {
      taskId,
      authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
      authorId: task.assigneeId ?? task.creatorId,
      body:
        `<!-- orbit:${WORK_NOT_ON_BRANCH_SIGNAL_CODE} -->\n` +
        `**Work did not reach the branch (recorded by Orbit)**\n\n` +
        `This task's run session has ended, but the runner's final commit failed: the changes are still uncommitted files in that session's worktree, ` +
        `and ${branch ? `branch \`${branch}\`` : 'the branch'} does not have them.\n\n` +
        `Note that the criterion is not affected: the EXECUTABLE acceptance command runs against the working tree, where the work is, so it passes all the same — ` +
        `"the criterion passed" and "the work is committed" were never the same thing.\n\n` +
        `Reason:\n${reason}\n\n` +
        `To recover it: open this task's session in Orbit and use Commit in the status bar to commit the worktree's changes to its own branch, ` +
        `then merge as usual. There is no need to run this task again.\n\n` +
        `Signal source: ${WORK_NOT_ON_BRANCH_SIGNAL_CODE}`,
    },
  });
}

/**
 * A reserved EXECUTABLE turn is a mechanical evaluator, so a transport/declaration mismatch is
 * not a failing criterion result and must not be turned into TaskStatus.FAILED. It still needs a
 * durable, human-readable exit: this append-only signal records the command that was owed, the
 * expectation it was bound to, and why no comparable exit-code fact exists.
 *
 * The first conversation-turn ACK owns this write, so one unavailable turn produces one comment;
 * a later attempt gets its own comment and a later comparable result closes the logical episode
 * while these records remain audit evidence.
 */
export async function postExecutableAcceptanceUnavailableComment(
  tx: Prisma.TransactionClient,
  taskId: string,
  command: string,
  expectedExitCode: number,
  reason: string,
): Promise<void> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { assigneeId: true, creatorType: true, creatorId: true },
  });
  if (!task) return;
  await tx.taskComment.create({
    data: {
      taskId,
      authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
      authorId: task.assigneeId ?? task.creatorId,
      body:
        `<!-- orbit:${EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE} -->\n` +
        `**Needs a person: EXECUTABLE acceptance could not be decided (recorded by Orbit)**\n\n` +
        `The acceptance command the task declares did not return a raw result that can be compared with the expected one; Orbit did not guess the task's status.\n\n` +
        `Command: ${command}\n\n` +
        `Expected exit code: ${expectedExitCode}\n\n` +
        `Why it could not be decided:\n${reason}\n\n` +
        `Fix the run environment or the declaration, then run the task again; if the work cannot go on, the run session should report FAILED explicitly.\n\n` +
        `Signal source: ${EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE}`,
    },
  });
}
