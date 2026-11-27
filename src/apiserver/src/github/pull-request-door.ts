import type { PullRequestCondition, PullRequestMergeMethod } from '@orbit/shared';
import type { GithubPullRequestCheck, GithubPullRequestReading } from './github-api.client';

/**
 * What one read of a pull request decides (docs/design/protected-branch-landing.md §4.3), as a pure function of the row
 * and GitHub's whole answer: Orbit acts on what GitHub says when it is asked, never on a webhook's payload.
 */
export type PullRequestDecision =
  /** GitHub says it merged, Orbit's merge or a person's: check the result, then land (J-T15). */
  | { kind: 'MERGED' }
  /** GitHub allows the merge and the base is where the head was built: merge it with `sha` = the head (§4.1 step 8). */
  | { kind: 'MERGE' }
  /** Closed without merging (J-T19). */
  | { kind: 'CLOSED' }
  /** The head is not the commit Orbit pushed (J-T20): Orbit merges only what it checked. */
  | { kind: 'HEAD_CHANGED' }
  /** A required check on the head failed (J-T16): these, in GitHub's order. */
  | { kind: 'CHECK_FAILED'; failed: GithubPullRequestCheck[] }
  /**
   * The target moved under the head (J-T17): GitHub says the pull request is behind (the repository requires
   * up-to-date branches) or conflicting, or it could merge but the base tip is not the one the head was built on. A
   * catch-up: the next attempt rebuilds on the new tip and updates the same pull request, and it is not counted
   * against J-T13's three or `AUTOMATIC_MERGE_ATTEMPTS` (§4.5). The one GitHub's merge call refuses for it is decided
   * where that call is made, and is counted.
   */
  | { kind: 'TARGET_MOVED' }
  /** Nothing to do until GitHub says something else: the checks, a review, GitHub working out mergeability. */
  | { kind: 'WAIT' };

/** The row facts a decision reads. */
export interface PullRequestFacts {
  /** What Orbit last pushed to the landing branch. */
  headSha: string | null;
  /** The base tip that head was built and checked on. */
  baseSha: string | null;
}

/** One read's verdict: what to do, the condition it is in, and its checks as the row keeps them. */
export interface PullRequestVerdict {
  decision: PullRequestDecision;
  condition: PullRequestCondition | null;
  checks: GithubPullRequestCheck[];
}

/** §4.3's table, in its order. */
export function decidePullRequest(row: PullRequestFacts, reading: GithubPullRequestReading): PullRequestVerdict {
  const checks = reading.checks;
  const required = checks.filter((check) => check.required);
  const verdict = (decision: PullRequestDecision, condition: PullRequestCondition | null): PullRequestVerdict =>
    ({ decision, condition, checks });
  if (reading.merged || reading.state === 'MERGED') return verdict({ kind: 'MERGED' }, null);
  if (reading.state === 'CLOSED') return verdict({ kind: 'CLOSED' }, null);
  if (!row.headSha || reading.headSha !== row.headSha) return verdict({ kind: 'HEAD_CHANGED' }, null);
  const failed = required.filter((check) => check.state === 'FAILED');
  if (failed.length > 0) return verdict({ kind: 'CHECK_FAILED', failed }, 'CHECK_FAILED');
  if (reading.mergeQueueEnabled || reading.inMergeQueue) return verdict({ kind: 'WAIT' }, 'MERGE_QUEUE');
  if (reading.mergeStateStatus === 'BEHIND') return verdict({ kind: 'TARGET_MOVED' }, 'BEHIND');
  if (reading.mergeable === 'CONFLICTING' || reading.mergeStateStatus === 'DIRTY') return verdict({ kind: 'TARGET_MOVED' }, 'CONFLICTING');
  if (reading.reviewDecision === 'CHANGES_REQUESTED') return verdict({ kind: 'WAIT' }, 'CHANGES_REQUESTED');
  if (required.some((check) => check.state === 'PENDING')) return verdict({ kind: 'WAIT' }, 'CHECKS_PENDING');
  if (reading.reviewDecision === 'REVIEW_REQUIRED') return verdict({ kind: 'WAIT' }, 'REVIEW_REQUIRED');
  if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(reading.mergeStateStatus)) {
    // GitHub would merge it. Orbit does only onto the base the head was built and checked on: a base that moved since
    // is J-T17's to rebuild on, in a repository that does not require up-to-date branches as in one that does.
    return reading.baseSha && reading.baseSha === row.baseSha
      ? verdict({ kind: 'MERGE' }, 'MERGEABLE')
      : verdict({ kind: 'TARGET_MOVED' }, 'BEHIND');
  }
  // BLOCKED with no failing or pending required check and no review asked for: GitHub is waiting on a required check
  // that has not reported yet. DRAFT and UNKNOWN: GitHub has not worked it out.
  if (reading.mergeStateStatus === 'BLOCKED') return verdict({ kind: 'WAIT' }, 'CHECKS_PENDING');
  return verdict({ kind: 'WAIT' }, 'UNKNOWN');
}

/** What a pull request lands: a project branch's promotion, a task's work, or a session's own Merge (§4.4). */
export type PullRequestSubject = 'PROJECT_BRANCH' | 'TASK' | 'SESSION';

/**
 * The method that gives what Orbit's direct push would have given (§4.4): a merge commit for a project branch, which
 * keeps its commits as ancestors of the target (M6), and a rebase for a task's work or a session's, which keeps the
 * target linear. When the repository does not allow that one, the next it allows; null when it allows none Orbit has
 * not already seen refused.
 */
export function mergeMethodFor(
  subject: PullRequestSubject,
  allowed: { merge: boolean; rebase: boolean; squash: boolean },
  refused: ReadonlySet<PullRequestMergeMethod> = new Set(),
): PullRequestMergeMethod | null {
  const order: PullRequestMergeMethod[] = subject === 'PROJECT_BRANCH'
    ? ['merge', 'rebase', 'squash']
    : ['rebase', 'merge', 'squash'];
  return order.find((method) => allowed[method] && !refused.has(method)) ?? null;
}

/**
 * Whether GitHub's 405 to a merge refused the method rather than the moment: the repository's settings, or a rule
 * requiring linear history, do not allow it. Any other 405 is GitHub not ready to merge yet, which the next read sees.
 */
export function mergeMethodRefused(message: string | null): boolean {
  const said = (message ?? '').toLowerCase();
  return said.includes('not allowed') || said.includes('merge commit') || said.includes('linear history');
}

/** Whether GitHub's 405 to a merge says the base moved since Orbit read it (J-T17, counted, §4.5). */
export function mergeRefusedForMovedBase(message: string | null): boolean {
  return (message ?? '').toLowerCase().includes('base branch was modified');
}
