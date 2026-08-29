/**
 * Parent task aggregation (contract AC7 / §13.1).
 *
 * One pure function over one snapshot of a Project's tasks. It answers a single question — given
 * what the children are RIGHT NOW, what should each parent's status be — and returns the writes
 * that would make that true. It performs none of them: the caller applies each as a compare-and-set
 * against the status this plan observed, so a snapshot that went stale changes nothing rather than
 * overwriting somebody else's newer fact.
 *
 * Being a recomputation is what makes it idempotent (AG1). There is no accumulator to double-count
 * and no permanent idempotency key to collide with, so a duplicated event, an event that arrives
 * out of order, two children completing concurrently and a process that restarts halfway all land
 * on the same answer: the one the current children imply. That is also why the plan is deliberately
 * NOT an entry in the durable action ledger (AG5) — a key built from a fact that can return to an
 * earlier value turns "do this again because the world came back" into "already did this once".
 */

import {
  successorChain,
  taskIsObsolete,
  type TaskRetirement,
} from '../tasks/task-supersession';
import {
  deriveTaskCompletionStatus,
  type TaskCompletionCriterionValue,
} from '../tasks/task-completion-criterion';

export const TASK_COMPLETION_POLICIES = [
  'MANUAL',
  'ALL_CHILDREN_DONE',
  'VERIFICATION_PASSED',
] as const;
export type TaskCompletionPolicyValue = (typeof TASK_COMPLETION_POLICIES)[number];

export const TASK_VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;
export type TaskVerdictValue = (typeof TASK_VERDICTS)[number];

export type AggregationTaskStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'CANCELLED'
  | 'FAILED';

/** One task as aggregation reads it. Ids are opaque and compared by identity only. */
export interface AggregationTaskFact {
  id: string;
  /** §13.6 SU1's pointer, needed to tell whether a replaced child's work stays in this subtree. */
  supersededByTaskId?: string | null;
  status: AggregationTaskStatus;
  parentTaskId: string | null;
  completionPolicy: TaskCompletionPolicyValue;
  /** Present on stored rows since N1. Optional keeps older pure-function callers readable. */
  completionCriterion?: TaskCompletionCriterionValue | null;
  verifiesTaskId: string | null;
  verdict: TaskVerdictValue | null;
  /**
   * §13.6 SU6: this attempt was replaced or abandoned. Optional, and absent reads as "not retired"
   * — a snapshot taken before the columns existed must aggregate to what it originally did.
   */
  retirement?: TaskRetirement | null;
}

/**
 * AG6 — the shape of a task that ONLY aggregation may finish, and which therefore may never be
 * dispatched as work.
 *
 * §13.1's three policies answer "when does this parent become DONE". `ALL_CHILDREN_DONE` and
 * `VERIFICATION_PASSED` both answer it with *other rows*: the parent's status is a function of its
 * children and of the checks pointed at it, recomputed by `planTaskAggregation` and written by a
 * CAS (AG5). Nothing about that answer involves the parent doing any work, and there is no state
 * a Session on the parent could reach that would satisfy it — an aggregate parent that runs is a
 * Session with no completion condition of its own.
 *
 * That is not a hypothetical. Dispatching one produces a real agent, in a real workspace, told to
 * execute a task whose entire content is the summary of work its children are doing concurrently:
 * it duplicates the children's work, races them for the same branch, and cannot report done —
 * because the only thing that may set this row DONE is the recomputation, which is watching the
 * children and not the Session.
 *
 * The two clauses, and why each is exactly where the line falls:
 *
 *  - **A direct child exists.** This is AG4 read forwards. A policy on a childless task is inert
 *    (`recompute` returns null for it), so only its declared completion criterion can complete it — it is
 *    an ordinary leaf that happens to carry a policy for the children it will have later, and
 *    refusing to run it would strand it. The two rules therefore share one predicate: aggregation
 *    is what completes this task **iff** the loop must not dispatch it.
 *
 *    That biconditional is about WHO may complete the task, and it is exact. It does not say the
 *    recomputation can always answer YES from the children this parent has right now, and the
 *    difference is the whole of `completionGap` below: a roll-up every one of whose children was
 *    cancelled, or one on `VERIFICATION_PASSED` with nothing pointed at it, is a task this
 *    predicate refuses to dispatch and `recompute` will never complete. Aggregation still OWNS it
 *    — that half holds — but the shape has no next step in it, so the gap is REPORTED (§11's
 *    `AGGREGATE_PARENT_UNSATISFIABLE` / `VERIFICATION_REQUIRED`) rather than resolved by weakening
 *    this predicate. Weakening it would dispatch the roll-up, which is the incident AG6 exists for.
 *  - **The policy is not `MANUAL`.** A MANUAL parent does not roll up its children; its declared
 *    completion criterion decides DONE and aggregation never second-guesses it.
 *
 * What is deliberately NOT a third clause: `task.isForeman`. An explicit Foreman is a task somebody
 * filed as the coordinating RUN for a list's work, so exempting it here reads as the obvious kindness
 * — and it is incoherent. `recompute` above does not exempt it: a Foreman with children and a
 * non-MANUAL policy is still recomputed FROM those children, so exempting it at the dispatch gate
 * produces a task with TWO completion owners — its declared criterion, and an
 * aggregation that writes DONE or drags it back OPEN from the children. They race, and AG3's
 * reopen makes the loser permanent.
 *
 * The invariant is therefore closed at the other end: **an effective Foreman is MANUAL.** The
 * combination is refused where it would be written (`TasksService`, and `task_foreman_manual_policy`
 * for writers this build does not contain), so for every task created from here on "not an explicit
 * Foreman" is implied by "the policy is not MANUAL" and needs no clause. A row that already carries
 * the combination — written before the constraint existed — is refused by this predicate like any
 * other aggregate parent, which is the structured refusal a mixed-version deployment needs rather
 * than a silent dispatch into a two-owner race.
 *
 * Deliberately NOT part of it either: `autoRunWhenReady`, a null assignee, and `dispatchHold`. All
 * three would express "do not run this" in a column a person or another sweep may legitimately
 * rewrite, turning a role invariant into a setting — and §2 B3 and §12.3 D4 forbid two of them by
 * name. The invariant is a property of the task's SHAPE, so it is re-derived from that shape at
 * every gate rather than stored.
 */
export interface AggregateParentFact {
  completionPolicy: TaskCompletionPolicyValue;
  /** At least one task names this one as its `parentTaskId`, within the same Project. */
  hasDirectChildren: boolean;
}

/** AG6: true when the ONLY thing that may complete this task is the recomputation above. */
export function isAggregateParent(fact: AggregateParentFact): boolean {
  if (fact.completionPolicy === 'MANUAL') return false;
  return fact.hasDirectChildren;
}

/**
 * True when `task_start` has no semantic work to execute on this row.
 *
 * Aggregate parents are completed by their children. A VERIFICATION subject is completed by its
 * independent verifier, even before it has any child rows; dispatching the subject itself cannot
 * produce the evidence its declared criterion requires. This is the shared service-door rule
 * behind manual Run, batch Run, session creation, retry and Work overview's Ready bucket.
 */
export function taskStartOwnedByCompletion(fact: AggregateParentFact & {
  completionCriterion?: TaskCompletionCriterionValue | null;
  verifiesTaskId?: string | null;
}): boolean {
  if (fact.completionCriterion === 'VERIFICATION' && fact.verifiesTaskId == null) return true;
  return isAggregateParent(fact);
}

/**
 * AG6's other end: the combination that would give one task two completion owners.
 *
 * `true` means the write must be refused — an explicit Foreman is a task whose SESSION is the work,
 * and a non-MANUAL policy says the children decide when it is finished. One task cannot be both.
 * Shared by `TasksService` and by the `task_foreman_manual_policy` constraint so the API and the
 * database refuse the same pair.
 */
export function foremanPolicyConflict(
  fact: { isForeman: boolean; completionPolicy: TaskCompletionPolicyValue },
): boolean {
  return fact.isForeman && fact.completionPolicy !== 'MANUAL';
}

export type TaskAggregationReason =
  | 'ALL_CHILDREN_DONE'
  | 'VERIFICATION_PASSED'
  | 'CHILDREN_OUTSTANDING'
  | 'VERIFICATION_OUTSTANDING';

/**
 * One planned compare-and-set. `from` is the status this plan read, and the caller must include it
 * in the WHERE clause: it is the whole of the concurrency control, and an update that matches zero
 * rows is a normal outcome, not an error.
 */
export interface PlannedTaskAggregation {
  taskId: string;
  from: AggregationTaskStatus;
  to: 'OPEN' | 'DONE';
  policy: TaskCompletionPolicyValue;
  reason: TaskAggregationReason;
  evidence: {
    children: { total: number; done: number; cancelled: number; outstanding: number };
    verifications: {
      total: number;
      passed: number;
      outstanding: number;
      /** Of `outstanding`, how many are DONE with no verdict — finished, and never concluding. */
      unconcludable: number;
    };
  };
}

/**
 * Why the recomputation cannot complete this aggregate parent from the rows it has.
 *
 *  - `NO_CHILD_CAN_COMPLETE` — every child has settled, and none of them settled as DONE. AG1's
 *    forward clause needs `done > 0`, so no event any of these children can still produce changes
 *    the answer. Restoring or adding a child is what changes it, and that is a decision.
 *  - `NO_VERIFICATION_FILED` — the children are settled, the policy is `VERIFICATION_PASSED`, and
 *    not one live check names this task. "Every one of zero verifications passed" is the same
 *    vacuous truth AG4 refuses, so the parent waits on a row that does not exist and that nothing
 *    would ever file on its account: a check is dispatched only after its subject is DONE, and this
 *    subject cannot reach DONE without it.
 *  - `SUCCESSOR_OUTSIDE_SUBTREE` — every outstanding child is a RETIRED attempt whose replacement
 *    is not in this subtree. `chainStaysUnder` counts those as outstanding on purpose (see it for
 *    why settling them would complete a parent over work that left), and that answer is right about
 *    the parent and incomplete about the clock: a retired attempt is never dispatched again (§13.6
 *    SU6), so "outstanding" here does not mean "not yet". Nothing moves until somebody re-parents
 *    the successor or unlinks the supersession, and until then the count cannot go down.
 */
export type TaskCompletionGapReason =
  | 'NO_CHILD_CAN_COMPLETE'
  | 'NO_VERIFICATION_FILED'
  /**
   * `[K5]` / `[H0V2]`: every check that is left FINISHED without concluding anything.
   *
   * Split out of `NO_VERIFICATION_FILED` rather than folded into it, although both mean "no check
   * can conclude this". The two send a reader to different places and admit different answers: a
   * subject with no check needs one FILED, which §13.2 V8 can do by itself, and a subject whose
   * check ran and recorded nothing needs somebody to find out WHY before another one is filed —
   * filing automatically here would mint one more check per pass, each able to end the same way.
   */
  | 'VERIFICATION_CANNOT_CONCLUDE'
  | 'SUCCESSOR_OUTSIDE_SUBTREE';

/**
 * One aggregate parent whose completion condition the CURRENT world cannot satisfy (§13.1 AG7).
 *
 * This is a statement about a shape, not about a failure: nothing went wrong, and every gate that
 * refused this task refused it correctly. What it records is that the refusals have nowhere to
 * hand off to — AG6 says only aggregation may finish the row, and aggregation has no answer — so
 * the loop owes somebody a row saying so rather than a silent OPEN nobody is watching.
 */
export interface TaskCompletionGap {
  taskId: string;
  /** The status the gap was observed on, so a reader can tell a stalled OPEN from a stalled FAILED. */
  status: AggregationTaskStatus;
  policy: TaskCompletionPolicyValue;
  reason: TaskCompletionGapReason;
  /**
   * The same counts the aggregation would have carried, so both faces cite one recomputation, plus
   * the one this face needs and that one does not: how many of the outstanding children are
   * outstanding on a row that will never move again.
   */
  evidence: {
    children: {
      total: number;
      done: number;
      cancelled: number;
      outstanding: number;
      /** Outstanding AND retired: counted as unfinished, and unfinishable where they now sit. */
      unresolvable: number;
    };
    verifications: {
      total: number;
      passed: number;
      outstanding: number;
      /** Of `outstanding`, how many are DONE with no verdict — finished, and never concluding. */
      unconcludable: number;
    };
  };
}

/** How one parent's direct children currently count, in AG1's own three buckets. */
export interface TaskChildCounts {
  done: number;
  outstanding: number;
  /** Of `outstanding`, how many are on a row §13.6 SU6 will never dispatch again (AG7). */
  unresolvable: number;
}

export interface TaskAggregationPlan {
  /** Sorted by task id, so the same snapshot always produces byte-identical audit. */
  aggregations: PlannedTaskAggregation[];
  /**
   * AG7: the aggregate parents this snapshot can neither complete nor dispatch, sorted by task id.
   *
   * Derived from the same pass and the same counts as `aggregations` so the two cannot disagree,
   * and deliberately a plain observation rather than a write — a gap is closed by somebody adding
   * the missing row, never by aggregation inventing a status the children do not support.
   */
  completionGaps: TaskCompletionGap[];
  /**
   * AG8's inputs: the child counts for every parent this pass counted, sorted by task id.
   *
   * Here rather than recomputed by each gate so "outstanding" has ONE definition — the supersession
   * clause above is subtle enough that a second copy of it is a second answer waiting to happen.
   */
  childCounts: Array<{ taskId: string; counts: TaskChildCounts }>;
  /**
   * Tasks that sit on a `parentTaskId` cycle. Non-empty means aggregation was skipped for the
   * whole Project (AG2): a cycle has no bottom to start from, so there is no "current children"
   * for any member of it. The service layer refuses to create one; this is the backstop for a
   * cycle that reached the database by some other route, and the input the DEPENDENCY_CYCLE
   * blocker will be raised from once §13 blockers exist.
   */
  cycleTaskIds: string[];
}

/**
 * Statuses a parent may be moved OUT of by aggregation.
 *
 * `FAILED` is in the set and `CANCELLED` is not, and the difference is who said it. CANCELLED is a
 * statement somebody made ABOUT the parent — aggregation only ever answers for the children, so it
 * leaves that alone. `FAILED` on an aggregate parent is not a statement anybody made: it is the
 * residue of a run that AG6 says should never have been started, and it is the exact shape this
 * project's own incident left behind on three roll-up nodes.
 *
 * Leaving it out is a wedge with no exit, which is why it had to move. AG6's gates skip a FAILED
 * aggregate parent before the retry ladder, and `TASK_AGGREGATE_PARENT` is a NON-blocking refusal —
 * so nothing retries it, nothing opens a row about it, and if aggregation also refuses to touch it,
 * its children can all reach DONE and the parent sits FAILED for ever with no next step anywhere.
 * That is §10.3's silent idling with a status on it.
 *
 * Recovery is therefore the aggregation role simply taking the status back: a FAILED parent whose
 * children are settled becomes DONE, and one whose children are outstanding becomes OPEN, both
 * derived from the same recomputation as every other transition here. The failed Session is NOT
 * touched — it keeps its real result, its error and its place in `failureCount`. What is corrected
 * is only the claim the TASK row was making, which was never its to make.
 */
const AGGREGATABLE_FROM: ReadonlySet<AggregationTaskStatus> = new Set<AggregationTaskStatus>([
  'OPEN',
  'IN_PROGRESS',
  'FAILED',
]);

/**
 * Is this check still one the subject can be waiting ON (§13.2 V8-d)?
 *
 * Two ways to stop being one, and they are the same sentence twice: RETIRED (the re-run that
 * replaced it is itself pointed at this subject and counted on its own row) and CANCELLED
 * (somebody stopped it, so the subject is back to having no check at all). Neither is a wait —
 * counting either would leave a `VERIFICATION_PASSED` subject outstanding for ever on a row nobody
 * will run, which is the same silent idling AG7 exists to end, one table over.
 *
 * Shared with the commit point on purpose. The planner decides "there is no live check, file one"
 * and the effect re-decides "there is still no live check" under the lock; two spellings of that
 * would eventually disagree about a CANCELLED one, and then the loop would file a check the effect
 * refuses, for ever, at one generation per pass.
 */
export function verificationIsLive(fact: {
  status: AggregationTaskStatus;
  retired: boolean;
}): boolean {
  return !fact.retired && fact.status !== 'CANCELLED';
}

/**
 * AG8 — §7.4 precondition 3, asked as a question about the SUBJECT rather than about its status.
 *
 * "A check may not run before the thing it checks is finished" is right for every ordinary subject
 * and is a deadlock for one shape: a `VERIFICATION_PASSED` aggregate parent is finished BY the
 * check, so requiring it to be DONE first makes the check undispatchable and the subject
 * uncompletable, each waiting on the other. AG7 reports that as `NO_VERIFICATION_FILED`; this is
 * the other half — filing the check is pointless if nothing will ever run it.
 *
 * The exception is exactly as narrow as the deadlock:
 *
 *  - Only `VERIFICATION_PASSED`, and only WITH children. `ALL_CHILDREN_DONE` has no such loop (the
 *    children complete it), and a childless task is an ordinary leaf whose policy is inert (AG4).
 *  - Only when the children are in — `outstanding === 0 && done > 0`, the same clause AG1 uses.
 *    A check dispatched over unfinished subtasks would be checking a moving target, which is the
 *    thing precondition 3 exists to prevent.
 *  - `unresolvable === 0` follows from `outstanding === 0` and is asserted by the caller's counts
 *    rather than restated: a subtree with a replacement outside it has AG7's own row to answer.
 *
 * The parent still gets NO Session of its own — AG6 is untouched, and this is about a DIFFERENT
 * task (the check) being allowed to run.
 */
export function verificationSubjectReady(fact: {
  status: AggregationTaskStatus;
  completionPolicy: TaskCompletionPolicyValue;
  hasDirectChildren: boolean;
  childrenDone: number;
  childrenOutstanding: number;
}): boolean {
  if (fact.status === 'DONE') return true;
  if (fact.status !== 'OPEN' && fact.status !== 'IN_PROGRESS') return false;
  if (fact.completionPolicy !== 'VERIFICATION_PASSED' || !fact.hasDirectChildren) return false;
  return fact.childrenOutstanding === 0 && fact.childrenDone > 0;
}

/**
 * The child counts AG8 needs, for every task in one snapshot, from the same walk `recompute` uses.
 *
 * Exported so the planner and any commit-point re-read ask ONE function rather than each writing
 * "outstanding means not DONE and not CANCELLED" and drifting on the supersession clause — which is
 * precisely the clause that was wrong above.
 */
export function aggregationChildCounts(
  tasks: readonly AggregationTaskFact[],
): Map<string, { done: number; outstanding: number; unresolvable: number }> {
  const plan = planTaskAggregation(tasks);
  const counts = new Map<string, { done: number; outstanding: number; unresolvable: number }>();
  for (const entry of plan.childCounts) counts.set(entry.taskId, entry.counts);
  return counts;
}

/**
 * Recompute every parent in `tasks` from its direct children.
 *
 * Bottom-up and multi-level in one pass (AG2): a grandparent is evaluated against what this same
 * plan concluded about its children, so a leaf finishing settles the whole chain above it in one
 * reconcile rather than one level per delivered event.
 *
 * `tasks` is one Project's tasks. A `parentTaskId` pointing outside the set is treated as no parent
 * here — a subtask must be in its parent's project (TasksService.assertParentEligible), so the only
 * way to observe that is a task on its way between projects, and guessing about the half of a tree
 * this snapshot cannot see is worse than waiting for the write that moved it to wake the loop.
 */
export function planTaskAggregation(
  tasks: readonly AggregationTaskFact[],
): TaskAggregationPlan {
  const byId = new Map<string, AggregationTaskFact>();
  for (const task of tasks) byId.set(task.id, task);

  const cycleTaskIds = findParentCycles(byId);
  // AG2: a cycle has no bottom, so there is no "current children" to recompute anybody from — and
  // therefore nothing to say about whether a parent's condition is satisfiable either. The
  // DEPENDENCY_CYCLE row is the one a person acts on, and a second, derived row per member would
  // describe the same inconsistency in worse words.
  if (cycleTaskIds.length > 0) {
    return { aggregations: [], completionGaps: [], childCounts: [], cycleTaskIds };
  }

  const children = new Map<string, AggregationTaskFact[]>();
  const verifiers = new Map<string, AggregationTaskFact[]>();
  for (const task of tasks) {
    if (task.parentTaskId && byId.has(task.parentTaskId)) {
      push(children, task.parentTaskId, task);
    }
    if (task.verifiesTaskId && byId.has(task.verifiesTaskId)) {
      push(verifiers, task.verifiesTaskId, task);
    }
  }
  for (const bucket of children.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  for (const bucket of verifiers.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));

  // §13.6 SU6's derived half, resolved once for the whole snapshot: a task is obsolete when it was
  // itself retired OR when it checks work that was. Both settle, and computing it here rather than
  // in `recompute` is what keeps the parent's answer and the verification's answer consistent.
  const obsolete = new Set<string>();
  for (const task of tasks) {
    if (taskIsObsolete({
      retirement: task.retirement ?? null,
      subjectRetirement: task.verifiesTaskId
        ? (byId.get(task.verifiesTaskId)?.retirement ?? null)
        : null,
    })) {
      obsolete.add(task.id);
    }
  }

  const planned = new Map<string, PlannedTaskAggregation>();
  const gaps = new Map<string, TaskCompletionGap>();
  const childCounts: Array<{ taskId: string; counts: TaskChildCounts }> = [];
  // `effective` is the status the parent above should be judged against: the recomputed one where
  // this plan changes it, the stored one everywhere else.
  const effective = new Map<string, AggregationTaskStatus>();

  // Sorted ids, each expanded bottom-up. Starting mid-tree is harmless: that node's own subtree is
  // evaluated first, and an ancestor reached later skips everything already settled. Preserve
  // that insertion order for writes: PostgreSQL's canonical DONE guard must observe descendants
  // settled before their ancestors, rather than an unrelated UUID ordering.
  for (const root of [...byId.keys()].sort()) {
    for (const id of postOrder(root, children, effective)) {
      const task = byId.get(id)!;
      const { write, gap, counts } = recompute(
        task, children.get(id) ?? [], verifiers.get(id) ?? [], effective, obsolete, byId,
      );
      if (write) planned.set(id, write);
      if (gap) gaps.set(id, gap);
      if (counts) childCounts.push({ taskId: id, counts });
      effective.set(id, write ? write.to : task.status);
    }
  }

  return {
    aggregations: [...planned.values()],
    completionGaps: [...gaps.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    childCounts: childCounts.sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    cycleTaskIds,
  };
}

/**
 * Does this replaced child's work stay under `parentId`?
 *
 * Walks the supersession chain to its end and asks whether that attempt is a child of the same
 * parent. Truncation (a cycle, or a chain longer than the database can write) answers NO, and so
 * does a successor this snapshot cannot see: both are cases where the honest answer is "cannot
 * tell", and a parent may not be completed on one.
 */
function chainStaysUnder(
  child: AggregationTaskFact,
  parentId: string,
  byId: ReadonlyMap<string, AggregationTaskFact>,
): boolean {
  const edges = new Map([...byId].map(([id, task]) => [id, task.supersededByTaskId ?? null]));
  const { chain, truncated } = successorChain(child.id, edges);
  if (truncated) return false;
  const tail = chain.at(-1);
  if (tail === undefined) return false;
  return byId.get(tail)?.parentTaskId === parentId;
}

/** What one recomputation concluded: the write it implies, and the gap it cannot write its way out
 *  of. At most one of each, and they are not exclusive — a FAILED roll-up whose children all
 *  cancelled is moved back to OPEN AND reported, because OPEN is where it then sits stuck. */
interface RecomputedTask {
  write: PlannedTaskAggregation | null;
  gap: TaskCompletionGap | null;
  /** AG8's inputs, present for every task this function counted children for. */
  counts: TaskChildCounts | null;
}

const NOTHING: RecomputedTask = { write: null, gap: null, counts: null };

function recompute(
  task: AggregationTaskFact,
  childTasks: readonly AggregationTaskFact[],
  verifierTasks: readonly AggregationTaskFact[],
  effective: ReadonlyMap<string, AggregationTaskStatus>,
  obsolete: ReadonlySet<string>,
  byId: ReadonlyMap<string, AggregationTaskFact>,
): RecomputedTask {
  // §13.6 SU6, about the task being RECOMPUTED rather than about its children. A retired parent's
  // CANCELLED or FAILED is the audit fact SU4 preserves, and aggregation may not rewrite it — not
  // to DONE when its children happen to have finished, and not back to OPEN when one is reopened.
  //
  // Left in, this is not merely wrong but LOUD: 0130's `task_retirement_status_check` refuses the
  // write, the caller logs a failure, and the next event recomputes the same plan and fails the
  // same way — a retired parent with subtasks would produce an error on every reconcile forever.
  //
  // It is also why a retired parent gets no AG7 gap: nothing is waiting on it, and asking somebody
  // to give a replaced attempt a subtask is a request addressed to no one.
  if (obsolete.has(task.id)) return NOTHING;
  if (task.completionPolicy === 'MANUAL') return NOTHING;
  // N1 made VERIFICATION an explicit ordinary criterion. A stored row that declares another
  // criterion must not be completed merely because a legacy completionPolicy still says
  // VERIFICATION_PASSED. Omitted means a pre-N1 pure-function fixture and retains that fixture's
  // historical aggregate semantics; database reads always supply the column.
  const explicitVerificationCriterion = task.completionCriterion === 'VERIFICATION';
  if (
    task.completionPolicy === 'VERIFICATION_PASSED'
    && task.completionCriterion != null
    && !explicitVerificationCriterion
  ) return NOTHING;
  // `[K5]`: aggregation may not COMPLETE a check that has concluded nothing.
  //
  // §13.2 V1 gives a check two carriers — its terminal status and its structured result — and
  // aggregation can supply only the first. Writing DONE here would mint precisely the shape
  // `[H0V2]` found and migration 0141 refuses (`VERDICT_REQUIRED_WITH_DONE`), and it would do it
  // from the one writer no person is behind: the roll-up would be "finished" and the epoch it
  // belongs to would still be shut, for ever. Reopening it (AG3) stays allowed — that direction
  // never claims a conclusion — so a check dragged back to OPEN by a reopened child still works.
  if (task.verifiesTaskId != null && task.verdict == null && task.status !== 'DONE') {
    return NOTHING;
  }
  // AG4. A policy on a childless task is inert, and stays inert rather than becoming inert-until-
  // someone-adds-a-child: nothing here writes when there is nothing to aggregate over. It is not a
  // gap either — AG6 does not refuse to dispatch it, so an ordinary leaf is exactly what it is.
  if (childTasks.length === 0 && !explicitVerificationCriterion) return NOTHING;

  let done = 0;
  let cancelled = 0;
  let outstanding = 0;
  let unresolvable = 0;
  for (const child of childTasks) {
    // DONE and CANCELLED settle; everything else — including FAILED — is outstanding. A failed
    // child is the case this distinction exists for: it has stopped, which is not the same as
    // being finished, and counting it as settled would complete a parent over a broken subtask.
    //
    // §13.6 SU6 adds the one exception, and it is the same sentence read the other way: a REPLACED
    // attempt has stopped AND is not the work anymore. Its successor is a sibling in this very
    // project, outstanding on its own account until it finishes, so counting the retired attempt
    // as unfinished counts one piece of work twice and holds the parent open on a row nobody will
    // ever move again. It settles as CANCELLED, which is what it is: an attempt that ended without
    // finishing, whose ending is now history.
    const status = effective.get(child.id) ?? child.status;
    // A replaced child settles ONLY when the work is still represented in this parent's subtree —
    // which means its chain ends at another child of THIS parent, counted on its own row.
    //
    // "The successor is a sibling" is a natural assumption and an unenforced one: SU3 requires the
    // same project, and nothing requires the same parent. A child superseded by a task under a
    // different parent (or under none) would otherwise settle here while the work that replaced it
    // is outside this subtree entirely, and the parent would report DONE over it. Fail closed: the
    // child stays outstanding, and re-parenting the successor — or unlinking — is a decision
    // somebody makes.
    const retired = obsolete.has(child.id);
    const replacedWithin = retired && chainStaysUnder(child, task.id, byId);
    // ORDER IS THE RULE HERE, and it was wrong in exactly one place. `CANCELLED` used to be tested
    // before the supersession clause, which meant a child that was cancelled BECAUSE it was
    // superseded settled on its status alone — and the fail-closed answer above, whose entire job
    // is to stop a parent completing over work that left its subtree, never ran for the shape it
    // was written for. SU4 preserves the retirement of a replaced attempt by CANCELLING it, so
    // that is not a corner case, it is the normal spelling.
    //
    // DONE stays first, and deliberately: if the child FINISHED, the work under this parent was
    // done here, and where a later attempt went is somebody else's ledger.
    if (status === 'DONE') done += 1;
    // A retired attempt whose work is NOT represented under this parent. Outstanding — the parent
    // is genuinely not finished — and outstanding FOREVER, because §13.6 SU6 never dispatches this
    // row again. `unresolvable` is what separates that from an ordinary wait; see AG7.
    //
    // Deliberately BEFORE the settled clause, and deliberately not narrowed to "names a successor".
    // Both halves are the fail-closed direction:
    //
    //  - Before, because SU4 preserves a replaced attempt by CANCELLING it. Testing `CANCELLED`
    //    first meant the fail-closed rule never ran for the shape it was written for, and the
    //    parent completed over work that had moved out from under it.
    //  - Not narrowed, because a retirement with no successor — ABANDONED, or SUPERSEDED whose
    //    successor was deleted (0128's FK is ON DELETE SET NULL) — is a subtask this parent is
    //    still counting and nobody will ever finish. "It stopped" is not "the parent's condition
    //    is satisfied": AG1 needs a DONE, and an abandoned attempt supplies none. Reading it as
    //    settled would complete a roll-up over work that was explicitly dropped.
    //
    // Both shapes are recoverable, and by a WRITE rather than by waiting, which is why they are a
    // §11 row and not a status: re-parent the successor here, clear the retirement so the row is an
    // ordinary child again, or remove the subtask.
    else if (retired && !replacedWithin) {
      outstanding += 1;
      unresolvable += 1;
    }
    // Settled: cancelled on its own account, or replaced by an attempt that is a sibling here and
    // is counted on its own row. An ABANDONED child with no successor lands here too — its chain
    // ends at itself, under this parent, which is what "dropped on purpose" means.
    else if (status === 'CANCELLED' || replacedWithin) cancelled += 1;
    else outstanding += 1;
  }
  // An explicit VERIFICATION criterion is satisfied by its independent PASS, exactly as N1's
  // evaluator states; it is not a hidden conjunction with the legacy parent roll-up. Older
  // aggregation fixtures (criterion omitted) retain the children condition they are testing.
  const childrenSettled = explicitVerificationCriterion || (outstanding === 0 && done > 0);

  let passed = 0;
  let verificationsOutstanding = 0;
  // `[K5]`: of the outstanding ones, those that have STOPPED without an answer. A DONE row is never
  // dispatched again, so no run will ever give this check a verdict — it is outstanding in the same
  // arithmetic as an unfinished one and in none of the ways that matter.
  let verificationsUnconcludable = 0;
  for (const verifier of verifierTasks) {
    // A retired check is neither a pass nor an outstanding one: the re-run that replaced it is
    // itself pointed at this subject and is counted on its own row. Leaving it outstanding would
    // make VERIFICATION_PASSED unreachable for every subject whose check was ever re-filed, which
    // is precisely the shape this project's own 04R / 04R2 / 04R3 history has.
    const status = effective.get(verifier.id) ?? verifier.status;
    if (!verificationIsLive({ status, retired: obsolete.has(verifier.id) })) continue;
    // Under N2 a coordinator/verifier records the independent verdict but may not write DONE.
    // For an explicitly declared VERIFICATION criterion, PASS is therefore the terminal evidence
    // itself; requiring the verifier row to be DONE would make the criterion unreachable. Legacy
    // aggregation callers (criterion omitted) keep the old two-carrier status+verdict rule.
    if (
      verifier.verdict === 'PASS'
      && (explicitVerificationCriterion || status === 'DONE')
    ) passed += 1;
    else {
      verificationsOutstanding += 1;
      if (status === 'DONE' && verifier.verdict == null) verificationsUnconcludable += 1;
    }
  }
  // Same shape as AG4 and for the same reason: "every one of zero verifications passed" is true and
  // means nothing, so VERIFICATION_PASSED with nothing pointed at this task never completes it.
  const verified = task.completionPolicy === 'VERIFICATION_PASSED'
    ? verificationsOutstanding === 0 && passed > 0
    : true;

  const verificationStatus = explicitVerificationCriterion
    ? deriveTaskCompletionStatus({
        completionCriterion: 'VERIFICATION',
        verificationVerdict: verified ? 'PASS' : null,
      })
    : null;
  const satisfied = explicitVerificationCriterion
    ? verificationStatus === 'DONE'
    : childrenSettled && verified;
  const counts: TaskChildCounts = { done, outstanding, unresolvable };
  const evidence = {
    children: { total: childTasks.length, done, cancelled, outstanding },
    verifications: {
      total: verifierTasks.length,
      passed,
      outstanding: verificationsOutstanding,
      unconcludable: verificationsUnconcludable,
    },
  };

  if (satisfied) {
    // A CANCELLED parent is left alone: that is a statement somebody made about the parent itself,
    // and aggregation only ever answers for the children. See `AGGREGATABLE_FROM` for why FAILED
    // is not in the same sentence any more.
    if (!AGGREGATABLE_FROM.has(task.status)) return { ...NOTHING, counts };
    return {
      counts,
      write: {
        taskId: task.id,
        from: task.status,
        to: 'DONE',
        policy: task.completionPolicy,
        reason: task.completionPolicy === 'VERIFICATION_PASSED'
          ? 'VERIFICATION_PASSED'
          : 'ALL_CHILDREN_DONE',
        evidence,
      },
      gap: null,
    };
  }

  // AG7, computed from the counts above rather than from a second read of the same rows.
  //
  // Only for a status aggregation could still move this task out of: a DONE parent is not stuck —
  // AG3 below reopens it in this very plan, and reporting both would open a row against a task
  // that is about to change status under it. CANCELLED is somebody's decision about the parent and
  // needs no next step from anybody.
  const reason = AGGREGATABLE_FROM.has(task.status)
    ? gapReason({
      policy: task.completionPolicy,
      done,
      outstanding,
      unresolvable,
      childrenSettled,
      passed,
      verificationsOutstanding,
      verificationsUnconcludable,
    })
    : null;
  const gap: TaskCompletionGap | null = reason === null
    ? null
    : {
      taskId: task.id,
      status: task.status,
      policy: task.completionPolicy,
      reason,
      evidence: { ...evidence, children: { ...evidence.children, unresolvable } },
    };

  // AG3. The reverse direction is the half that keeps this a recomputation: without it a reopened
  // child, a new child, a revoked verdict or a verification that came back FAIL would leave the
  // parent asserting a completion its own subtree no longer supports.
  //
  // `FAILED` joins `DONE` here for the reason `AGGREGATABLE_FROM` gives: it is the other status an
  // aggregate parent can be stuck in while its children are still moving, and the only difference
  // is which wrong claim the row is making. OPEN is what both become — the children are
  // outstanding, so the parent is outstanding.
  if (task.status !== 'DONE' && task.status !== 'FAILED') return { write: null, gap, counts };
  return {
    counts,
    write: {
      taskId: task.id,
      from: task.status,
      to: 'OPEN',
      policy: task.completionPolicy,
      reason: childrenSettled ? 'VERIFICATION_OUTSTANDING' : 'CHILDREN_OUTSTANDING',
      evidence,
    },
    gap,
  };
}

/**
 * Which half of the completion condition the current rows can never satisfy, if either.
 *
 * Both clauses are the same sentence AG4 makes about a childless parent, read one level in: a
 * count that is zero and can no longer move is not "not yet", it is "not from here". Nothing about
 * TIME closes either one — no child left will change status, and no check exists to conclude — so
 * waiting is not a strategy and the loop says so instead.
 *
 * Order matters when both hold. `NO_CHILD_CAN_COMPLETE` wins because it is the one that has to be
 * fixed first: a `VERIFICATION_PASSED` roll-up with no completed child would still not complete on
 * a PASS, so asking for the check first would send somebody to file a check that changes nothing.
 */
function gapReason(counts: {
  policy: TaskCompletionPolicyValue;
  done: number;
  outstanding: number;
  unresolvable: number;
  childrenSettled: boolean;
  passed: number;
  verificationsOutstanding: number;
  verificationsUnconcludable: number;
}): TaskCompletionGapReason | null {
  const { policy, done, outstanding, unresolvable, childrenSettled } = counts;
  // Every child settled and not one of them finished. AG1's forward clause needs `done > 0`, and
  // no event these rows can still produce provides it.
  if (outstanding === 0 && done === 0) return 'NO_CHILD_CAN_COMPLETE';
  // Outstanding, and every one of them on a row §13.6 SU6 will never dispatch again. ONE live
  // child is enough to make this an ordinary wait instead — the parent is then blocked on work
  // that is still moving, which is what a parent is for.
  if (outstanding > 0 && outstanding === unresolvable) return 'SUCCESSOR_OUTSIDE_SUBTREE';
  // The children are in; the policy waits on a check, and not one live check names this task.
  // `passed` and `verificationsOutstanding` both zero is exactly "there are none" — a FAIL or an
  // unfinished check counts as outstanding, and that is an ordinary wait rather than a gap.
  if (policy === 'VERIFICATION_PASSED' && childrenSettled
      && counts.passed === 0 && counts.verificationsOutstanding === 0) {
    return 'NO_VERIFICATION_FILED';
  }
  // `[K5]` / `[H0V2]`'s residue, and the sentence one line up was wrong about. "A FAIL or an
  // unfinished check counts as outstanding, and that is an ordinary wait" is true of a FAIL — §13.2
  // raises its own condition row — and true of an unfinished check, which is still running. It is
  // false of a check that reached DONE and recorded nothing: that row will never move again, and
  // reading it as a wait is what left this shape with no write, no gap, no condition, and one WARN
  // every sixty seconds. One live check is enough to make it an ordinary wait again, which is why
  // this asks that EVERY outstanding one has stopped.
  if (policy === 'VERIFICATION_PASSED' && childrenSettled && counts.passed === 0
      && counts.verificationsOutstanding > 0
      && counts.verificationsOutstanding === counts.verificationsUnconcludable) {
    return 'VERIFICATION_CANNOT_CONCLUDE';
  }
  return null;
}

/**
 * Every task that lies on a `parentTaskId` cycle, sorted.
 *
 * Iterative rather than recursive, and bounded by the node count rather than by a depth constant:
 * this exists precisely for data that should be impossible, so it must not trust the shape it is
 * handed. Nodes that merely hang BELOW a cycle are not reported — they are not themselves the
 * inconsistency — but they get no aggregation either, because the whole Project is skipped.
 */
function findParentCycles(byId: ReadonlyMap<string, AggregationTaskFact>): string[] {
  const state = new Map<string, 'VISITING' | 'DONE'>();
  const onCycle = new Set<string>();

  for (const start of [...byId.keys()].sort()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let cursor: string | null = start;
    while (cursor && !state.has(cursor)) {
      state.set(cursor, 'VISITING');
      path.push(cursor);
      const next: string | null = byId.get(cursor)?.parentTaskId ?? null;
      cursor = next && byId.has(next) ? next : null;
    }
    if (cursor && state.get(cursor) === 'VISITING') {
      for (const id of path.slice(path.indexOf(cursor))) onCycle.add(id);
    }
    for (const id of path) state.set(id, 'DONE');
  }
  return [...onCycle].sort();
}

/** Ids of `root`'s not-yet-evaluated subtree, children before parents. */
function postOrder(
  root: string,
  children: ReadonlyMap<string, AggregationTaskFact[]>,
  evaluated: ReadonlyMap<string, AggregationTaskStatus>,
): string[] {
  if (evaluated.has(root)) return [];
  const out: string[] = [];
  const stack: Array<{ id: string; expanded: boolean }> = [{ id: root, expanded: false }];
  const queued = new Set<string>([root]);
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.expanded) {
      out.push(frame.id);
      continue;
    }
    stack.push({ id: frame.id, expanded: true });
    for (const child of children.get(frame.id) ?? []) {
      if (evaluated.has(child.id) || queued.has(child.id)) continue;
      queued.add(child.id);
      stack.push({ id: child.id, expanded: false });
    }
  }
  return out;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}
