import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * How a forked task's work gets back to the session it was forked from (docs/task-fork-from-session-design.md
 * §2.5, D3 A): the forking session merges the task's branch itself, and the turn a `task_await` wakes it with
 * says how. One entry per forked task the watch names:
 *
 *  - `branch`: the branch the task's work is on — the delivered branch of a DONE task, else its newest run's;
 *    null while no run has one.
 *  - `forkSha` / `baseHead`: the snapshot the task started from, and the forking session's HEAD under it.
 *  - `snapshotChangedFiles`: the paths the snapshot changed relative to `baseHead` (migration 0617). An edit
 *    the forking session reverted after the snapshot comes back through the merge without a conflict (§2.7
 *    F4), and these are the files where that can happen.
 *  - `reviewCommand` / `mergeCommand` / `mergeInstruction`: only once the task is DONE and has a branch. Read
 *    `git diff HEAD...<branch>` first, then `git merge --no-ff <branch>`, in the forking session's checkout.
 */
export interface ForkHandback {
  taskId: string;
  branch: string | null;
  forkSha: string;
  baseHead: string;
  includesUncommitted: boolean;
  snapshotChangedFiles: string[];
  reviewCommand?: string;
  mergeCommand?: string;
  mergeInstruction?: string;
}

/** `git diff HEAD...<branch>`: what the task's branch changed since it left the forking session's line. */
export function forkReviewCommand(branch: string): string {
  return `git diff HEAD...${branch}`;
}

/** The one command design §2.5 gives the forking session. */
export function forkMergeCommand(branch: string): string {
  return `git merge --no-ff ${branch}`;
}

/** The instruction, in the order it has to be followed (§2.7 F4 before §2.5). */
export function forkMergeInstruction(branch: string): string {
  return `In the checkout of the session this task was forked from, first read \`${forkReviewCommand(branch)}\`: `
    + 'an edit you reverted after the snapshot comes back through the merge without a conflict, so check '
    + `the snapshot's files in that diff. Then run \`${forkMergeCommand(branch)}\`.`;
}

/**
 * The hand-back of every forked task among `tasks`, in their order; a task that was not forked, or is not
 * the owner's, has none. `status` is the task's status as the caller observed it — for a watch, the one its
 * Match recorded, so the merge command appears exactly when that Match saw the task DONE.
 */
export async function readForkHandbacks(
  db: PrismaService | Prisma.TransactionClient,
  ownerId: string,
  tasks: ReadonlyArray<{ id: string; status: string | null }>,
): Promise<ForkHandback[]> {
  if (tasks.length === 0) return [];
  const rows = await db.task.findMany({
    where: { ownerId, id: { in: [...new Set(tasks.map((t) => t.id))] }, forkSha: { not: null } },
    select: {
      id: true,
      forkSha: true,
      forkBaseHead: true,
      forkIncludesUncommitted: true,
      forkChangedFiles: true,
      deliveredBranch: true,
      sessions: {
        where: { branch: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { branch: true },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: ForkHandback[] = [];
  for (const { id, status } of tasks) {
    const row = byId.get(id);
    if (!row || !row.forkSha || !row.forkBaseHead) continue;
    const branch = row.deliveredBranch ?? row.sessions[0]?.branch ?? null;
    out.push({
      taskId: row.id,
      branch,
      forkSha: row.forkSha,
      baseHead: row.forkBaseHead,
      includesUncommitted: row.forkIncludesUncommitted === true,
      snapshotChangedFiles: row.forkChangedFiles,
      ...(branch && status === 'DONE'
        ? {
            reviewCommand: forkReviewCommand(branch),
            mergeCommand: forkMergeCommand(branch),
            mergeInstruction: forkMergeInstruction(branch),
          }
        : {}),
    });
  }
  return out;
}
