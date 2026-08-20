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
  status: AggregationTaskStatus;
  parentTaskId: string | null;
  completionPolicy: TaskCompletionPolicyValue;
  verifiesTaskId: string | null;
  verdict: TaskVerdictValue | null;
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

/** Statuses a parent may be moved OUT of by aggregation. */
const AGGREGATABLE_FROM: ReadonlySet<AggregationTaskStatus> = new Set<AggregationTaskStatus>([
  'OPEN',
  'IN_PROGRESS',
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

  const planned = new Map<string, PlannedTaskAggregation>();
  // `effective` is the status the parent above should be judged against: the recomputed one where
  // this plan changes it, the stored one everywhere else.
  const effective = new Map<string, AggregationTaskStatus>();

  // Sorted ids, each expanded bottom-up. Starting mid-tree is harmless: that node's own subtree is
  // evaluated first, and an ancestor reached later skips everything already settled.
  for (const root of [...byId.keys()].sort()) {
    for (const id of postOrder(root, children, effective)) {
      const task = byId.get(id)!;
      const aggregation = recompute(task, children.get(id) ?? [], verifiers.get(id) ?? [], effective);
      if (aggregation) planned.set(id, aggregation);
      effective.set(id, aggregation ? aggregation.to : task.status);
    }
  }

  return {
    aggregations: [...planned.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    cycleTaskIds,
  };
}

function recompute(
  task: AggregationTaskFact,
  childTasks: readonly AggregationTaskFact[],
  verifierTasks: readonly AggregationTaskFact[],
  effective: ReadonlyMap<string, AggregationTaskStatus>,
): PlannedTaskAggregation | null {
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
    const status = effective.get(child.id) ?? child.status;
    if (status === 'DONE') done += 1;
    else if (status === 'CANCELLED') cancelled += 1;
    else outstanding += 1;
  }
  const childrenSettled = outstanding === 0 && done > 0;

  let passed = 0;
  let verificationsOutstanding = 0;
  for (const verifier of verifierTasks) {
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
    // CANCELLED and FAILED parents are left alone. Both are statements somebody made about the
    // parent itself, and aggregation only ever answers for the children.
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
  if (task.status !== 'DONE') return null;
  return {
    taskId: task.id,
    from: 'DONE',
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
