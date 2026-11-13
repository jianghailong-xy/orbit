import type { WatchLeaf, WatchLeafParams, WatchPredicate } from '../watches/watch-predicate';

/** One wait the outgoing coordinator set, as the replacement's confirm dialog lists it. */
export interface CoordinatorPendingWait {
  id: string;
  label: string;
}

/** What a leaf waits FOR, as the end of "Waiting for <target> …". */
function leafPhrase(leaf: WatchLeaf, params?: WatchLeafParams): string {
  const seconds = params && 'seconds' in params ? params.seconds : null;
  switch (leaf) {
    case 'TASK_TERMINAL': return 'to finish';
    case 'TASK_DONE': return 'to be DONE';
    case 'TASK_FAILED': return 'to fail';
    case 'TASK_PROGRESS_AT_LEAST':
      return params && 'percent' in params
        ? `to reach ${params.percent}%`
        : `to reach ${params && 'current' in params ? params.current : 'its target'}`;
    case 'TASK_NO_PROGRESS_FOR': return `to make no progress for ${seconds}s`;
    case 'SESSION_TURN_SETTLED': return 'to finish its turn';
    case 'SESSION_RUN_TERMINAL': return 'to end its run';
    case 'SESSION_LIFECYCLE_TERMINAL': return 'to be completed';
    case 'SESSION_NEEDS_ATTENTION': return 'to need attention';
    case 'SESSION_JOB_NO_OUTPUT_FOR': return `to have a job go quiet for ${seconds}s`;
    default: return 'to change';
  }
}

/** The first leaf a predicate asks — a compound one is named by its first term. */
function firstLeaf(predicate: WatchPredicate): { leaf: WatchLeaf; params?: WatchLeafParams } | null {
  if ('leaf' in predicate) return { leaf: predicate.leaf, params: predicate.params };
  for (const operand of predicate.operands ?? []) {
    const found = firstLeaf(operand);
    if (found) return found;
  }
  return null;
}

/**
 * A short human description of one wait: `Waiting for "Fix login redirect" to be DONE`, or
 * `Waiting for "A" and 2 more to finish` when it watches several targets. `targetTitles` are the
 * titles of its targets in order; a target that no longer exists is passed as null.
 */
export function pendingWaitLabel(predicate: unknown, targetTitles: ReadonlyArray<string | null>): string {
  const leaf = predicate && typeof predicate === 'object' ? firstLeaf(predicate as WatchPredicate) : null;
  const first = targetTitles[0];
  const subject = targetTitles.length === 0
    ? 'its targets'
    : `${first == null ? 'a deleted target' : `"${first}"`}${targetTitles.length > 1 ? ` and ${targetTitles.length - 1} more` : ''}`;
  return `Waiting for ${subject} ${leaf ? leafPhrase(leaf.leaf, leaf.params) : 'to change'}`;
}
