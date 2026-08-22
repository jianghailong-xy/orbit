import { TaskStatus } from '@orbit/shared';

/**
 * Where a task sits relative to its prerequisites (the tasks it `dependsOn`). Derived
 * live from the prerequisites' Task.status — never stored — so it always reflects the
 * current graph (cf. TasksService.withRunning, which derives `running` the same way).
 *
 * Resolution is anchored entirely on Task.status (the product decision: "A 完成" means
 * Task.status === DONE), so the rule is simple and predictable:
 *   - no prerequisites                     -> NONE
 *   - any prerequisite CANCELLED / FAILED  -> BLOCKED_FAILED  (terminal failure; needs a human)
 *   - every prerequisite DONE              -> READY
 *   - otherwise (some still OPEN / IN_PROGRESS) -> BLOCKED (waiting)
 * A prerequisite left at OPEN (e.g. a retryable run hiccup, see reclaimStalledTask) keeps
 * its dependents BLOCKED until it's retried; an explicit CANCELLED or a genuine FAILED run
 * escalates to BLOCKED_FAILED.
 */
export type DependencyState = 'NONE' | 'READY' | 'BLOCKED' | 'BLOCKED_FAILED';

export function computeDependencyState(prerequisiteStatuses: TaskStatus[]): DependencyState {
  if (prerequisiteStatuses.length === 0) return 'NONE';
  if (prerequisiteStatuses.some((s) => s === TaskStatus.CANCELLED || s === TaskStatus.FAILED))
    return 'BLOCKED_FAILED';
  if (prerequisiteStatuses.every((s) => s === TaskStatus.DONE)) return 'READY';
  return 'BLOCKED';
}

/**
 * The same rule as `computeDependencyState`, decided from tallies instead of from one entry per
 * prerequisite — for the callers that count in SQL because hydrating a row per edge is exactly the
 * fan-out they exist to avoid.
 *
 * It lives here, beside the rule it restates, so the two cannot drift apart unnoticed;
 * `task-dependencies.spec.ts` proves they agree on every combination of tallies.
 */
export function dependencyStateFromCounts(counts: {
  /** How many prerequisites the task has at all. Zero is what makes the state `NONE`. */
  prerequisites: number;
  /** Of those, how many are CANCELLED or FAILED — terminal, so waiting will not clear them. */
  terminal: number;
  /** Of those, how many are DONE. */
  done: number;
}): DependencyState {
  if (counts.prerequisites === 0) return 'NONE';
  if (counts.terminal > 0) return 'BLOCKED_FAILED';
  return counts.done === counts.prerequisites ? 'READY' : 'BLOCKED';
}

/** A task may be executed only when it has no unmet prerequisites. */
export function canRun(state: DependencyState): boolean {
  return state === 'NONE' || state === 'READY';
}

/** A dependency edge: `taskId` (the dependent) waits on `dependsOnTaskId` (the prerequisite). */
export interface DependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

/**
 * Would adding "`taskId` depends on `dependsOnTaskId`" close a cycle in the existing
 * graph? A self-edge is a trivial cycle. Otherwise a cycle forms iff the prerequisite
 * already (transitively) depends on the dependent — i.e. following dependency edges
 * (dependent -> prerequisite) from `dependsOnTaskId` can reach `taskId`. We must keep
 * the graph a DAG so the completion-triggered runner can never loop forever.
 */
export function wouldCreateCycle(
  edges: DependencyEdge[],
  taskId: string,
  dependsOnTaskId: string,
): boolean {
  if (taskId === dependsOnTaskId) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.taskId);
    if (list) list.push(e.dependsOnTaskId);
    else adjacency.set(e.taskId, [e.dependsOnTaskId]);
  }
  const seen = new Set<string>();
  const stack = [dependsOnTaskId];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === taskId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    const next = adjacency.get(node);
    if (next) stack.push(...next);
  }
  return false;
}

/** Would atomically replacing one task's prerequisites with `dependsOnTaskIds` form a cycle? */
export function wouldReplacementCreateCycle(
  edges: DependencyEdge[],
  taskId: string,
  dependsOnTaskIds: string[],
): boolean {
  // The old outgoing edges disappear as part of the replacement, so validate against
  // the graph that will remain. Every proposed edge starts at the same task; a cycle
  // exists iff any proposed prerequisite can already reach that task.
  const retainedEdges = edges.filter((edge) => edge.taskId !== taskId);
  return dependsOnTaskIds.some((dependsOnTaskId) =>
    wouldCreateCycle(retainedEdges, taskId, dependsOnTaskId),
  );
}
