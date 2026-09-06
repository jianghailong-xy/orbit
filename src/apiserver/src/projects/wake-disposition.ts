import type { TaskSettlement } from './coordinator-wake';

/**
 * Whether a committed fact changes what the coordinator would decide — and therefore whether it is
 * worth a judgment session at all.
 *
 * §0 — RECORDING IS UNCONDITIONAL; OPENING IS NOT
 * ===============================================
 * A wake row is cheap, idempotent and ageable, so every authorized fact leaves one. A judgment
 * session is none of those: it queues a runner, spends a model turn and produces a decision
 * somebody has to live with. Before this unit existed, every authorized wake went on to open one,
 * which made "was this worth thinking about" a question nothing asked.
 *
 * NOT OPENING IS NOT A REFUSAL. `REFUSED` means the wake was not allowed — the switch is off, the
 * project is gone, the convergence ledger says this project is no longer converging — and it
 * releases the fact's idempotency key so the same fact may be delivered again. What this unit
 * decides is what an ALLOWED wake is spent on, and both of its answers are terminal states inside
 * 0174's partial unique index: the fact goes on holding its key either way. A reader of the ledger
 * can therefore tell the three apart — `REFUSED` was not permitted, `CONSUMED` was recorded and
 * nothing more, `SESSION_OPENED` was judged.
 *
 * §1 — THE INPUT IS A CRITERION'S COVERAGE, NOT A TASK'S STATUS
 * =============================================================
 * "The task failed" is not the question. A coordinator reasons about whether the project's stated
 * conditions are still on their way to being met, so the input is what one acceptance criterion's
 * serving work says about that criterion — the same unit `CRITERION_READY` is cut in, and for the
 * same reason cutting per task is wrong at both ends.
 *
 * The two readings the project goal states, in this vocabulary:
 *
 *   * a task ends and the criterion it serves still has other work outstanding — `IN_FLIGHT`.
 *     Nothing changed: that outstanding work will finish, and the coordinator will be asked then.
 *   * a task fails and it was the only work serving a criterion — `STRANDED`. Everything changed:
 *     no work is going to deliver that criterion, and nothing but a decision can move it.
 *
 * §2 — WHY `BACKED` IS NOT A DECISION EITHER
 * ==========================================
 * A criterion every serving task of which is DONE has run out of work too, and it is deliberately
 * NOT a decision. The coordinator's tools are the reversible ones — redispatch, succeed, split,
 * cancel, escalate, file more work — and a criterion whose work is finished needs none of them.
 * What it needs is a judgment about whether the claim actually holds, and this project states in
 * as many words that nothing in Orbit answers that: the ruler is a person's editable list, and
 * whoever edits it can make any conclusion true. So a backed criterion is recorded, on the surface
 * a person reads, and no session is opened to decide something no session may decide.
 *
 * §3 — A FACT THAT BEARS ON NO CRITERION CHANGES NO CRITERION'S COVERAGE
 * =====================================================================
 * Work that declares no criterion is work whose end moves nothing this unit can reason about, so
 * it is recorded and nothing more. That is the same choice `CRITERION_READY` makes about a
 * criterion nobody serves, and it is the honest one: the alternative is to open a session on the
 * strength of a task's status alone, which is the per-task cut §1 rejects.
 */

/** The statuses in which a task is still expected to deliver, with nobody deciding anything. */
export const PENDING_TASK_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

export function isPendingTaskStatus(status: string): boolean {
  return (PENDING_TASK_STATUSES as readonly string[]).includes(status);
}

/** What the work serving one acceptance criterion says about that criterion. */
export type CriterionCoverage =
  /** Work other than the one this fact is about is still expected to deliver it. */
  | 'IN_FLIGHT'
  /** Every task serving it is DONE. The claim is backed; §2 says that is nobody's next step. */
  | 'BACKED'
  /** Nothing is going to deliver it and nothing did. Only a decision moves this criterion. */
  | 'STRANDED';

/**
 * Fold one criterion's serving work into its coverage.
 *
 * `endedTaskId` is the task whose attempt this fact is ABOUT, and it is excluded from the "still
 * expected to deliver" half on purpose: its run just ended, so whatever its status column says, it
 * is not work anybody is waiting on. It stays in the second half, because whether the criterion is
 * BACKED is a question about all of its work, including the piece that just stopped.
 *
 * An empty serving set is STRANDED rather than BACKED. `[].every` is vacuously true, and a
 * criterion nobody has filed any work against has not been met — it has not been attempted.
 */
export function criterionCoverage(
  serving: readonly TaskSettlement[],
  endedTaskId?: string,
): CriterionCoverage {
  const awaited = serving.filter((task) => task.taskId !== endedTaskId);
  if (awaited.some((task) => isPendingTaskStatus(task.status))) return 'IN_FLIGHT';
  if (serving.length === 0) return 'STRANDED';
  if (serving.every((task) => task.status === 'DONE')) return 'BACKED';
  return 'STRANDED';
}

/** What an authorized wake is spent on. Both are terminal; neither is a refusal. */
export type WakeDisposition =
  /** Open the one judgment session this fact gets. */
  | 'OPEN_JUDGMENT'
  /** Leave the ledger row and stop. The fact is durable, ageable, and nobody is interrupted. */
  | 'RECORD_ONLY';

/**
 * The decision, over the coverage of every criterion the fact bears on.
 *
 * One stranded criterion is enough: a fact that leaves any stated condition with no work and no
 * backing is a fact the coordinator has to answer, whatever the rest of the project looks like.
 */
export function wakeDisposition(coverage: readonly CriterionCoverage[]): WakeDisposition {
  return coverage.includes('STRANDED') ? 'OPEN_JUDGMENT' : 'RECORD_ONLY';
}
