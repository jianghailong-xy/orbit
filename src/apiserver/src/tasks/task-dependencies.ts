import { TaskStatus } from '@orbit/shared';

/**
 * Where a task sits relative to its prerequisites (the tasks it `dependsOn`). Derived
 * live from the prerequisites' Task.status — never stored — so it always reflects the
 * current graph (cf. TasksService.withRunning, which derives `running` the same way).
 *
 * Resolution is anchored entirely on Task.status (the product decision: "A 完成" means
 * Task.status === DONE), so the rule is simple and predictable:
 *   - no prerequisites            -> NONE
 *   - any prerequisite CANCELLED  -> BLOCKED_FAILED  (terminal failure; needs a human)
 *   - every prerequisite DONE     -> READY
 *   - otherwise (some still OPEN / IN_PROGRESS) -> BLOCKED (waiting)
 * A prerequisite whose run failed leaves that task at OPEN (see reclaimStalledTask), so
 * its dependents stay BLOCKED until it's retried — only an explicit CANCELLED escalates
 * to BLOCKED_FAILED.
 */
export type DependencyState = 'NONE' | 'READY' | 'BLOCKED' | 'BLOCKED_FAILED';

export function computeDependencyState(prerequisiteStatuses: TaskStatus[]): DependencyState {
  if (prerequisiteStatuses.length === 0) return 'NONE';
  if (prerequisiteStatuses.some((s) => s === TaskStatus.CANCELLED)) return 'BLOCKED_FAILED';
  if (prerequisiteStatuses.every((s) => s === TaskStatus.DONE)) return 'READY';
  return 'BLOCKED';
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
