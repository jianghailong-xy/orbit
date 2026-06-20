import { Prisma, RunStatus, TaskStatus } from '@prisma/client';

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
 * the task its agent left at IN_PROGRESS would otherwise stay "in progress" forever
 * with nothing actually running — the list shows a perpetual running indicator.
 * Task.status is an agent-owned label (see TasksService.withRunning), so we only
 * nudge it back: if NO other session for the task is still occupying it, move
 * IN_PROGRESS -> `resetTo` so the abandoned work surfaces. `resetTo` is OPEN for a
 * retryable end (user cancel / runner offline) — back to the actionable pool — or
 * FAILED for a genuine run failure that needs a human. No-op when another session is
 * still live or the task isn't IN_PROGRESS.
 *
 * Call inside the SAME transaction that finalized the session, AFTER the session's
 * status has been flipped to terminal — so the just-ended session is no longer
 * counted as occupying.
 */
export async function reclaimStalledTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  resetTo: TaskStatus = TaskStatus.OPEN,
): Promise<void> {
  const occupied = await tx.session.count({
    where: { taskId, status: { in: TASK_OCCUPYING } },
  });
  if (occupied > 0) return;
  await tx.task.updateMany({
    where: { id: taskId, status: 'IN_PROGRESS' },
    data: { status: resetTo },
  });
}
