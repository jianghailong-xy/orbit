/**
 * Landing through a pull request (docs/design/protected-branch-landing.md): the names a runner and the control
 * plane share, and the block the clients read about a landing that waits on GitHub.
 */

/**
 * How a landing reaches its target (§3), chosen by the control plane when it hands the attempt out and recorded on
 * it (`land_via`). `PUSH` pushes the target and has no pull request to fall back to. `PULL_REQUEST` pushes the target
 * as today and, when GitHub refuses that push because of the branch's rules, pushes the landing branch instead and
 * lands through a pull request. `PUSH_AS_ME` is the same with the owner's own GitHub token on the target push.
 */
export type LandVia = 'PUSH' | 'PULL_REQUEST' | 'PUSH_AS_ME';

/** The runner capability that says an integration job's protected refusal becomes a landing-branch push (§9 item 7). */
export const INTEGRATION_PULL_REQUEST_CAPABILITY = 'integration-pull-request/v1';

/** The runner capability that says a session's Merge does the same (§4.6, §9 item 7). */
export const SESSION_MERGE_PULL_REQUEST_CAPABILITY = 'session-merge-pull-request/v1';

/**
 * The runner capability that says Push as me works on this runner (§5.2, §9 item 3): right after the push boundary
 * it asks `POST /runner/git-credential` with `purpose: 'PUSH_AS_ME'` for the owner's own GitHub token, pushes the
 * target with that token alone, and falls back to the landing branch when GitHub refuses. A runner without it is never
 * handed `PUSH_AS_ME`: one with only `integration-pull-request/v1` would push the target with today's credential.
 */
export const PUSH_AS_ME_CAPABILITY = 'push-as-me/v1';

/** The workspace's landing setting as the owner chooses it (§7 `workspace.landing_mode`; NULL reads PULL_REQUEST). */
export type WorkspaceLandingMode = 'PULL_REQUEST' | 'PUSH_AS_ME';

/** The last time GitHub (or Orbit's credential route) refused a Push as me landing on a workspace (§5.5, §11.1). */
export interface PushAsMeRefusalView {
  /** ISO-8601. */
  at: string;
  /** The target branch, without `refs/heads/`. */
  branch: string;
  /** GitHub's words, or Orbit's reason when the owner's token could not be had. */
  message: string;
}

/**
 * A workspace's `landing` block (§8), on `GET /workspaces/:id`. `mode` is null for a workspace not cloned from GitHub,
 * which has no choice: its landings push with the machine's Git credential.
 */
export interface WorkspaceLandingView {
  mode: WorkspaceLandingMode | null;
  pushAsMe: { available: boolean; reason?: 'WORKSPACE_NOT_FROM_GITHUB' | 'GITHUB_NOT_CONNECTED' };
  lastRefusal: PushAsMeRefusalView | null;
  /**
   * The workspace's installation has not accepted the permissions landing through a pull request needs (§10): the
   * account that must accept, and the GitHub page where it does. Absent when accepted or when GitHub could not be asked.
   */
  permissionsPending?: { account: string; reviewUrl: string };
}

/** Where Orbit pushes a landing GitHub refused on its target: `refs/heads/orbit/land/<id>` (§4.1). */
export const LANDING_REF_PREFIX = 'refs/heads/orbit/land/';

/** The landing branch of one landing subject: its landing session's id, or the session's own for a Merge. */
export function landingRefFor(id: string): string {
  return `${LANDING_REF_PREFIX}${id}`;
}

/** A branch Orbit owns (`project/*`, `orbit/*`): pushed directly, never through a pull request (§3). */
export function isOrbitOwnedRef(ref: string): boolean {
  const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  return name.startsWith('project/') || name.startsWith('orbit/');
}

/** A pull request Orbit opened, as its row reads (§7). `OPENING` is the row written before GitHub answered. */
export type PullRequestState = 'OPENING' | 'OPEN' | 'MERGED' | 'CLOSED';

/**
 * What GitHub said about an open pull request at Orbit's last read (§4.3). Waiting for checks, for a review, or for
 * GitHub to work out whether it can merge are conditions of the pull request, never states of the landing.
 */
export type PullRequestCondition =
  | 'CHECKS_PENDING'
  | 'CHECK_FAILED'
  | 'REVIEW_REQUIRED'
  | 'CHANGES_REQUESTED'
  | 'BEHIND'
  | 'CONFLICTING'
  | 'MERGEABLE'
  | 'MERGE_QUEUE'
  | 'UNKNOWN';

export const PULL_REQUEST_CONDITIONS: readonly PullRequestCondition[] = [
  'CHECKS_PENDING', 'CHECK_FAILED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', 'BEHIND', 'CONFLICTING', 'MERGEABLE',
  'MERGE_QUEUE', 'UNKNOWN',
];

/** How GitHub merges the pull request (§4.4). */
export type PullRequestMergeMethod = 'merge' | 'rebase' | 'squash';

/**
 * A landing's pull request, as the landing view, a task's landing row, a project's in-flight jobs and a session's
 * merge row carry it (§8). `number` and `url` are null only while the row is `OPENING`: GitHub has not answered yet.
 */
export interface LandingPullRequestView {
  number: number | null;
  url: string | null;
  state: PullRequestState;
  condition: PullRequestCondition | null;
  /** The required checks on the head: how many passed, how many there are, and the ones that failed. */
  checks: { passed: number; required: number; failed: Array<{ name: string; url: string | null }> };
  mergeMethod: PullRequestMergeMethod | null;
  /** The commit GitHub's merge put on the target. */
  mergedSha: string | null;
  /** The direct push GitHub refused before this pull request, in GitHub's words. */
  refusal: { via: 'PULL_REQUEST' | 'PUSH_AS_ME'; message: string } | null;
  /** The workspace the pull request was opened for: clients read its landing setting and link to it. Absent from an older server. */
  workspaceId?: string;
}
