"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_OCCUPYING = void 0;
exports.reclaimStalledTask = reclaimStalledTask;
exports.postRunFailureComment = postRunFailureComment;
const client_1 = require("@prisma/client");
// Sessions that could still be working a task: live (RUNNING/AWAITING_INPUT/
// INTERRUPTED) or queued for a runner slot (PENDING). Mirrors the reaper's LIVE
// set plus PENDING.
exports.TASK_OCCUPYING = [
    client_1.RunStatus.PENDING,
    client_1.RunStatus.RUNNING,
    client_1.RunStatus.AWAITING_INPUT,
    client_1.RunStatus.INTERRUPTED,
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
 * counted as occupying.
 */
async function reclaimStalledTask(tx, taskId, resetTo = client_1.TaskStatus.OPEN) {
    const occupied = await tx.session.count({
        where: { taskId, status: { in: exports.TASK_OCCUPYING } },
    });
    if (occupied > 0)
        return;
    await tx.task.updateMany({
        where: { id: taskId, status: 'IN_PROGRESS' },
        data: { status: resetTo },
    });
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
async function postRunFailureComment(tx, taskId, reason) {
    const task = await tx.task.findUnique({
        where: { id: taskId },
        select: { assigneeId: true, creatorType: true, creatorId: true },
    });
    if (!task)
        return;
    await tx.taskComment.create({
        data: {
            taskId,
            authorType: task.assigneeId ? client_1.CreatorType.AGENT : task.creatorType,
            authorId: task.assigneeId ?? task.creatorId,
            body: `**执行失败（系统自动记录）**\n\n本任务的一次执行会话因运行错误中止，未完成。\n\n` +
                `失败原因：\n${reason}\n\n可重新运行本任务重试。`,
        },
    });
}
//# sourceMappingURL=reclaim-stalled-task.js.map