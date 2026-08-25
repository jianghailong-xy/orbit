import { CreatorType, Prisma, RunStatus, TaskStatus } from '@prisma/client';

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
 */
export async function reclaimStalledTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  resetTo: TaskStatus = TaskStatus.OPEN,
): Promise<boolean> {
  const occupied = await tx.session.count({
    where: { taskId, status: { in: TASK_OCCUPYING } },
  });
  if (occupied > 0) return false;
  const changed = await tx.task.updateMany({
    where: { id: taskId, status: 'IN_PROGRESS' },
    data: { status: resetTo },
  });
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
        `**执行失败（系统自动记录）**\n\n本任务的一次执行会话因运行错误中止，未完成。\n\n` +
        `失败原因：\n${reason}\n\n可重新运行本任务重试。`,
    },
  });
}
