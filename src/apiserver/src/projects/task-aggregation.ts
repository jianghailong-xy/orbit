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
 *    (`recompute` returns null for it), so nothing but a status write can ever complete it — it is
 *    an ordinary leaf that happens to carry a policy for the children it will have later, and
 *    refusing to run it would strand it. The two rules therefore share one predicate: aggregation
 *    is what completes this task **iff** the loop must not dispatch it.
 *  - **The policy is not `MANUAL`.** A MANUAL parent is completed by an explicit status write and
 *    by nothing else (AG1's table, first row), so a person or an agent is expected to act on it.
 *    That is the pre-§13.1 contract for every parent task in the product, and it stays.
 *
 * What is deliberately NOT a third clause: `task.isForeman`. An explicit Foreman is a task somebody
 * filed as the coordinating RUN for a list's work, so exempting it here reads as the obvious kindness
 * — and it is incoherent. `recompute` above does not exempt it: a Foreman with children and a
 * non-MANUAL policy is still recomputed FROM those children, so exempting it at the dispatch gate
 * produces a task with TWO completion owners — a Worker that runs it and writes DONE, and an
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
    verifications: { total: number; passed: number; outstanding: number };
  };
}

export interface TaskAggregationPlan {
  /** Sorted by task id, so the same snapshot always produces byte-identical audit. */
  aggregations: PlannedTaskAggregation[];
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
  if (cycleTaskIds.length > 0) return { aggregations: [], cycleTaskIds };

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
  // `effective` is the status the parent above should be judged against: the recomputed one where
  // this plan changes it, the stored one everywhere else.
  const effective = new Map<string, AggregationTaskStatus>();

  // Sorted ids, each expanded bottom-up. Starting mid-tree is harmless: that node's own subtree is
  // evaluated first, and an ancestor reached later skips everything already settled.
  for (const root of [...byId.keys()].sort()) {
    for (const id of postOrder(root, children, effective)) {
      const task = byId.get(id)!;
      const aggregation = recompute(
        task, children.get(id) ?? [], verifiers.get(id) ?? [], effective, obsolete, byId,
      );
      if (aggregation) planned.set(id, aggregation);
      effective.set(id, aggregation ? aggregation.to : task.status);
    }
  }

  return {
    aggregations: [...planned.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
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

function recompute(
  task: AggregationTaskFact,
  childTasks: readonly AggregationTaskFact[],
  verifierTasks: readonly AggregationTaskFact[],
  effective: ReadonlyMap<string, AggregationTaskStatus>,
  obsolete: ReadonlySet<string>,
  byId: ReadonlyMap<string, AggregationTaskFact>,
): PlannedTaskAggregation | null {
  // §13.6 SU6, about the task being RECOMPUTED rather than about its children. A retired parent's
  // CANCELLED or FAILED is the audit fact SU4 preserves, and aggregation may not rewrite it — not
  // to DONE when its children happen to have finished, and not back to OPEN when one is reopened.
  //
  // Left in, this is not merely wrong but LOUD: 0130's `task_retirement_status_check` refuses the
  // write, the caller logs a failure, and the next event recomputes the same plan and fails the
  // same way — a retired parent with subtasks would produce an error on every reconcile forever.
  if (obsolete.has(task.id)) return null;
  if (task.completionPolicy === 'MANUAL') return null;
  // AG4. A policy on a childless task is inert, and stays inert rather than becoming inert-until-
  // someone-adds-a-child: nothing here writes when there is nothing to aggregate over.
  if (childTasks.length === 0) return null;

  let done = 0;
  let cancelled = 0;
  let outstanding = 0;
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
    const replacedWithin = obsolete.has(child.id) && chainStaysUnder(child, task.id, byId);
    if (status === 'DONE') done += 1;
    else if (status === 'CANCELLED' || replacedWithin) cancelled += 1;
    else outstanding += 1;
  }
  const childrenSettled = outstanding === 0 && done > 0;

  let passed = 0;
  let verificationsOutstanding = 0;
  for (const verifier of verifierTasks) {
    // A retired check is neither a pass nor an outstanding one: the re-run that replaced it is
    // itself pointed at this subject and is counted on its own row. Leaving it outstanding would
    // make VERIFICATION_PASSED unreachable for every subject whose check was ever re-filed, which
    // is precisely the shape this project's own 04R / 04R2 / 04R3 history has.
    if (obsolete.has(verifier.id)) continue;
    const status = effective.get(verifier.id) ?? verifier.status;
    if (status === 'DONE' && verifier.verdict === 'PASS') passed += 1;
    else verificationsOutstanding += 1;
  }
  // Same shape as AG4 and for the same reason: "every one of zero verifications passed" is true and
  // means nothing, so VERIFICATION_PASSED with nothing pointed at this task never completes it.
  const verified = task.completionPolicy === 'VERIFICATION_PASSED'
    ? verificationsOutstanding === 0 && passed > 0
    : true;

  const satisfied = childrenSettled && verified;
  const evidence = {
    children: { total: childTasks.length, done, cancelled, outstanding },
    verifications: {
      total: verifierTasks.length,
      passed,
      outstanding: verificationsOutstanding,
    },
  };

  if (satisfied) {
    // A CANCELLED parent is left alone: that is a statement somebody made about the parent itself,
    // and aggregation only ever answers for the children. See `AGGREGATABLE_FROM` for why FAILED
    // is not in the same sentence any more.
    if (!AGGREGATABLE_FROM.has(task.status)) return null;
    return {
      taskId: task.id,
      from: task.status,
      to: 'DONE',
      policy: task.completionPolicy,
      reason: task.completionPolicy === 'VERIFICATION_PASSED'
        ? 'VERIFICATION_PASSED'
        : 'ALL_CHILDREN_DONE',
      evidence,
    };
  }

  // AG3. The reverse direction is the half that keeps this a recomputation: without it a reopened
  // child, a new child, a revoked verdict or a verification that came back FAIL would leave the
  // parent asserting a completion its own subtree no longer supports.
  //
  // `FAILED` joins `DONE` here for the reason `AGGREGATABLE_FROM` gives: it is the other status an
  // aggregate parent can be stuck in while its children are still moving, and the only difference
  // is which wrong claim the row is making. OPEN is what both become — the children are
  // outstanding, so the parent is outstanding.
  if (task.status !== 'DONE' && task.status !== 'FAILED') return null;
  return {
    taskId: task.id,
    from: task.status,
    to: 'OPEN',
    policy: task.completionPolicy,
    reason: childrenSettled ? 'VERIFICATION_OUTSTANDING' : 'CHILDREN_OUTSTANDING',
    evidence,
  };
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
