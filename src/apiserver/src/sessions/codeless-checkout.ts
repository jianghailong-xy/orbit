import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { CODELESS_CHECKOUT_V1 } from '@orbit/shared';
import { slugify } from './naming';

/**
 * A codeless task's run (docs/task-fork-from-session-design.md §3, option B2, chosen as D5): isolated in its
 * own checkout like any run on a workspace with worktrees on, but with no branch until it has something to
 * put on one. The session is created with `branch` NULL; the claim asks the runner for a detached checkout
 * at the run's base (`git worktree add --detach`); at finalize the runner removes that checkout when nothing
 * changed, so no branch ever exists, or creates `codelessBranch` there, commits and reports it with its
 * changed files. The finalize door accepts a branch first reported then for this kind of session only.
 */

/** The facts that make a session a codeless task's run: a task it executes, codeless, not forked. */
export interface CodelessCheckoutFacts {
  taskId: string | null;
  sourceKind: string | null;
  task: { codeless: boolean } | null;
}

/**
 * Whether this session runs a codeless task. A forked task always gets a branch (SR55, design §2.4) and a
 * session that executes no task is not one, so neither is.
 */
export function isCodelessTaskRun(session: CodelessCheckoutFacts): boolean {
  return session.taskId != null && session.task?.codeless === true && session.sourceKind !== 'SESSION_FORK';
}

/**
 * The branch a codeless run's work goes on if it has any: `orbit/<slug>-<6 hex>`, as `makeBranchName` names
 * every session branch, but derived from the session id rather than drawn at random, so every claim of the
 * same session names the same branch.
 */
export function codelessBranchName(title: string, sessionId: string): string {
  const slug = slugify(title);
  const suffix = createHash('sha256').update(sessionId).digest('hex').slice(0, 6);
  return slug ? `orbit/${slug}-${suffix}` : `orbit/session-${suffix}`;
}

/**
 * The claim's half (QueueService.buildSession): what a codeless run with no branch yet is handed. A runner
 * that declares `codeless-checkout/v1` gets the detached checkout and the branch to make if anything
 * changes; an older one is handed the branch up front, as every codeless run was before, so it is still
 * isolated (and the branch it then reports at finalize is accepted below).
 */
export function codelessClaimFields(
  session: CodelessCheckoutFacts & { id: string; title: string; branch: string | null },
  workspace: { enableWorktree: boolean } | null | undefined,
  runnerCapabilities: readonly string[] | null | undefined,
): { branch?: string; codelessCheckout?: true; codelessBranch?: string } {
  if (session.branch != null || !workspace?.enableWorktree || !isCodelessTaskRun(session)) return {};
  const name = codelessBranchName(session.title, session.id);
  return (runnerCapabilities ?? []).includes(CODELESS_CHECKOUT_V1)
    ? { codelessCheckout: true, codelessBranch: name }
    : { branch: name };
}

/**
 * The finalize door's half: the branch a finalize report may write. A session that has a branch keeps
 * taking what the runner reports, as it always has. One with none takes a reported branch only when it is a
 * codeless task's run, whose branch is made at finalize; any other report of a branch nobody created the
 * session with is ignored.
 */
export async function acceptedFinalizeBranch(
  tx: Prisma.TransactionClient,
  current: { taskId: string | null; branch: string | null; sourceKind: string | null },
  reported: string | null | undefined,
): Promise<string | undefined> {
  if (!reported) return undefined;
  if (current.branch != null) return reported;
  if (!current.taskId) return undefined;
  const task = await tx.task.findUnique({ where: { id: current.taskId }, select: { codeless: true } });
  return isCodelessTaskRun({ ...current, task }) ? reported : undefined;
}
