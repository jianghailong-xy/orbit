import { CreatorType, Prisma, RunStatus, TaskStatus } from '@prisma/client';

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
        `**成果没有落到分支上（系统自动记录）**\n\n` +
        `本任务的执行会话已结束，但 runner 的收尾提交失败了：改动仍以未提交文件的形式留在该会话的 worktree 里，` +
        `分支${branch ? ` \`${branch}\`` : ''}上没有它们。\n\n` +
        `注意判据不受影响：EXECUTABLE 验收命令跑的是工作树，成果就在那里，所以它照样能通过——` +
        `「判据通过」和「成果已提交」从来不是同一件事。\n\n` +
        `失败原因：\n${reason}\n\n` +
        `回收办法：在 Orbit 里打开这条任务的会话，用状态栏的 Commit 把 worktree 里的改动提交到它自己的分支，` +
        `然后照常合并。不需要重新运行本任务。\n\n` +
        `信号来源：${WORK_NOT_ON_BRANCH_SIGNAL_CODE}`,
    },
  });
}

/**
 * Durable evidence for the one EXECUTABLE command a Task declared. `rawOutput` is appended last and
 * unchanged, so everything after the labelled boundary is exactly the runner's combined
 * stdout/stderr (including an empty string or a missing trailing newline). The status is a
 * server-side comparison result, never prose supplied by the executing session.
 */
export async function postExecutableAcceptanceComment(
  tx: Prisma.TransactionClient,
  taskId: string,
  command: string,
  expectedExitCode: number,
  actualExitCode: number,
  rawOutput: string,
  status: TaskStatus,
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
        `**EXECUTABLE 验收命令（系统自动执行）**\n\n` +
        `命令：${command}\n\n` +
        `期望退出码：${expectedExitCode}\n` +
        `实际退出码：${actualExitCode}\n` +
        `推导状态：${status}\n\n` +
        `原始输出（stdout/stderr 合并，未裁剪；PostgreSQL 不可存储的 NUL 除外）：\n` +
        rawOutput,
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
        `**需要人工介入：EXECUTABLE 验收未能判定（系统自动记录）**\n\n` +
        `任务声明的验收命令没有返回可与期望值比较的原始结果；系统没有猜测任务状态。\n\n` +
        `命令：${command}\n\n` +
        `期望退出码：${expectedExitCode}\n\n` +
        `无法判定原因：\n${reason}\n\n` +
        `请修复执行环境或声明后重新运行任务；若工作不再可继续，请由执行会话明确报告 FAILED。\n\n` +
        `信号来源：${EXECUTABLE_ACCEPTANCE_UNAVAILABLE_SIGNAL_CODE}`,
    },
  });
}
