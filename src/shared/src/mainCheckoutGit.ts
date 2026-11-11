import type { RunnerRepoHealth } from './dto';

/**
 * Main checkout Git: the contract every layer shares (docs/main-checkout-git-contract.md, design board
 * docs/mocks/main-checkout-git/).
 *
 * The "main checkout" is the directory a workspace points at — the checkout session worktrees fork from
 * and merge back into, and the one a Shared session works in directly. When it holds uncommitted changes,
 * a person decides who they belong to (this session / the current branch / a rescue branch), and the
 * runner does the Git: move, commit, push or rescue. Each action carries the fingerprint of the snapshot
 * the person looked at; the runner recomputes it before touching anything and refuses on any difference.
 *
 * Shapes, codes and copy live here so the web, the apiserver and every native client say the same thing.
 * `src/runner-go/main_checkout_types.go` mirrors the wire shapes; `main-checkout-git.fixture.json` holds
 * both to one set of examples.
 */

/** Runner capability (sent in X-Orbit-Runner-Capabilities). A runner without it gets no actions: the
 *  clients draw the card's text and no buttons. Go twin: mainCheckoutGitCapabilityV1. */
export const MAIN_CHECKOUT_GIT_CAPABILITY = 'main-checkout-git/v1';

/** The most files a snapshot lists, and counts. Past it the runner stops and sets `truncated`. */
export const MAIN_CHECKOUT_FILE_LIMIT = 200;
/** Files the card shows before folding the rest into "and N more". */
export const MAIN_CHECKOUT_CARD_VISIBLE_FILES = 8;
/** Bytes of one file's patch the diff read returns before cutting it off (`patchTruncated`). */
export const MAIN_CHECKOUT_PATCH_MAX_BYTES = 256 * 1024;
/** How long the apiserver waits for a runner's result before failing the request with TIMEOUT. */
export const MAIN_CHECKOUT_ACTION_TIMEOUT_SECONDS = 300;

/** A file's change against HEAD, working tree included. No rename detection: a rename is D + A. */
export type MainCheckoutFileStatus = 'M' | 'A' | 'D';

/** One changed path in the main checkout. Ignored files never appear; untracked ones do. */
export interface MainCheckoutFile {
  /** Repo-relative, '/'-separated. */
  path: string;
  status: MainCheckoutFileStatus;
  /** Git blob id of the working-tree content (`git hash-object <path>`), or '-' when deleted. */
  contentHash: string;
  /** Not in the index (never `git add`ed). */
  untracked?: boolean;
  binary?: boolean;
  /** Line counts against HEAD; absent for binary files. */
  additions?: number;
  deletions?: number;
}

/** What the runner sees in a main checkout right now (GET /workspaces/:id/main-checkout). */
export interface MainCheckoutSnapshot {
  /** realpath of the repo root (`git rev-parse --show-toplevel`, symlinks resolved). */
  root: string;
  /** Current branch; absent when HEAD is detached. */
  branch?: string;
  /** HEAD commit (full sha); absent before the first commit. */
  head?: string;
  /** RunnerRepoHealth.state vocabulary: 'clean' | 'dirty' | 'unmerged' | 'merge' | 'rebase' | ... */
  state: string;
  /** Upstream ref (e.g. 'origin/main'); absent when the branch has none. */
  upstream?: string;
  /** Commits on the branch not on upstream / on upstream not on the branch (as of the last fetch). */
  ahead?: number;
  behind?: number;
  /** Sorted by path (UTF-8 byte order). At most MAIN_CHECKOUT_FILE_LIMIT entries. */
  files: MainCheckoutFile[];
  /** How many files the runner counted: files.length, or the limit when truncated. */
  fileCount: number;
  /** The runner stopped counting at MAIN_CHECKOUT_FILE_LIMIT; there are more. */
  truncated: boolean;
  /** See mainCheckoutFingerprint in the contract: `mc1:<head|->:<sha256 hex>`. Covers every changed
   *  file, including those past the limit. */
  fingerprint: string;
  checkedAt: string;
}

/** One file's patch, read on demand — never on the heartbeat. */
export interface MainCheckoutFileDiff {
  path: string;
  binary: boolean;
  /** Unified diff against HEAD; absent for binary files. */
  patch?: string;
  /** The patch was cut at MAIN_CHECKOUT_PATCH_MAX_BYTES. */
  patchTruncated?: boolean;
}

/** Fields the runner adds to each heartbeat `repos[]` entry once it declares the capability. Counts and
 *  the fingerprint only: never file contents, never patches. */
export interface MainCheckoutHeartbeatFields {
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Changed files, capped at MAIN_CHECKOUT_FILE_LIMIT. */
  fileCount?: number;
  truncated?: boolean;
  fingerprint?: string;
}

export type MainCheckoutRepoHealth = RunnerRepoHealth & MainCheckoutHeartbeatFields;

export const MAIN_CHECKOUT_ACTION_KINDS = ['move', 'commit', 'push', 'rescue'] as const;
export type MainCheckoutActionKind = (typeof MAIN_CHECKOUT_ACTION_KINDS)[number];

/** POST /workspaces/:id/main-checkout/actions. */
export interface MainCheckoutActionRequest {
  kind: MainCheckoutActionKind;
  /** The snapshot's root. */
  root: string;
  /** The snapshot's fingerprint, as the person saw it. Push checks only its HEAD part. */
  fingerprint: string;
  /** move, commit: the chosen paths (non-empty, all in the snapshot). push, rescue: absent. */
  files?: string[];
  /** commit only: the commit message, non-blank. */
  message?: string;
  /** move only: the session whose worktree receives the files. */
  targetSessionId?: string;
  /** Client-generated; a repeat with the same id returns the first request's outcome. */
  requestId: string;
}

/** POST /workspaces/:id/main-checkout/actions as the apiserver takes it: the request, plus the session the person
 *  pressed it in. That session gets the result line (§7); without one the outcome is only on the request. */
export interface MainCheckoutActionPost extends MainCheckoutActionRequest {
  initiatedFromSessionId?: string;
}

/** Control plane → runner: the request, with the deadline after which the runner must not start it. */
export interface MainCheckoutActionCommand extends MainCheckoutActionRequest {
  /** move: the target session's worktree branch, so the runner needs no lookup. */
  targetBranch?: string;
  requestedAt: string;
  expiresAt: string;
}

export const MAIN_CHECKOUT_REFUSAL_CODES = [
  'FINGERPRINT_STALE',
  'HEAD_MOVED',
  'MOVE_CONFLICT',
  'MOVE_SOURCE_CHANGED',
  'TARGET_BUSY',
  'CHECKOUT_BLOCKED',
  'DETACHED',
  'NO_HEAD',
  'NOTHING_TO_PUSH',
  'NO_REMOTE',
  'PUSH_REJECTED',
  'PUSH_AUTH_FAILED',
  'PUSH_FAILED',
  'RESCUE_FAILED',
  'ACTION_IN_FLIGHT',
  'RUNNER_OFFLINE',
  'TIMEOUT',
  'CANCELLED',
] as const;
export type MainCheckoutRefusalCode = (typeof MAIN_CHECKOUT_REFUSAL_CODES)[number];

/**
 * done: it happened. partial: MOVE_SOURCE_CHANGED only — copied to the target, not cleared from the
 * source. refused: nothing changed. waiting: RUNNER_OFFLINE only — not run yet; a later result follows.
 */
export type MainCheckoutResultStatus = 'done' | 'partial' | 'refused' | 'waiting';

export interface MainCheckoutActionResult {
  requestId: string;
  kind: MainCheckoutActionKind;
  root: string;
  status: MainCheckoutResultStatus;
  /** Set unless status is 'done'. */
  code?: MainCheckoutRefusalCode;
  branch?: string;
  /** Files the action took (move, commit, rescue). */
  fileCount?: number;
  /** Changed files left in the main checkout afterwards (move). */
  remaining?: number;
  /** move, rescue: the branch holding the main checkout as it was. Orbit never deletes it. */
  rescueBranch?: string;
  /** commit: the new commit. rescue: the commit the checkout was returned to. HEAD_MOVED: HEAD now. */
  head?: string;
  /** commit: the first line of the message. */
  subject?: string;
  /** commit, push: upstream ref ('origin/main'), or the one a push would set. */
  upstream?: string;
  /** push: the remote ref before (absent for a new branch) and after. */
  remoteBefore?: string;
  remoteAfter?: string;
  /** move: where the files went. */
  targetSessionId?: string;
  targetBranch?: string;
  /** FINGERPRINT_STALE, MOVE_CONFLICT, MOVE_SOURCE_CHANGED: the paths that decided it. */
  paths?: string[];
  /** CHECKOUT_BLOCKED: the state in the way ('rebase', 'merge', 'unmerged', ...). */
  state?: string;
  /** PUSH_REJECTED: commits the branch has that upstream doesn't. */
  ahead?: number;
  /** PUSH_REJECTED: commits upstream has that the branch doesn't. */
  behind?: number;
  /** PUSH_*, RESCUE_FAILED: git's own reason, one line, with credentials and URLs' userinfo removed. */
  gitMessage?: string;
  /** RUNNER_OFFLINE, TIMEOUT. */
  runnerName?: string;
  /** RUNNER_OFFLINE: minutes since the runner last checked in. TIMEOUT: minutes waited. */
  minutes?: number;
  finishedAt: string;
}

// ---------------------------------------------------------------------------------------------
// The relay (contract §10): how a read or an action reaches the runner and how its answer comes back.

/** The code `POST …/main-checkout/actions` refuses with (HTTP 409) when the workspace's runner lacks the capability. */
export const MAIN_CHECKOUT_UNSUPPORTED_CODE = 'MAIN_CHECKOUT_UNSUPPORTED';
/** The most files one GET may ask the patch of (`?diff=` repeated). */
export const MAIN_CHECKOUT_DIFF_PATHS_MAX = 20;
/** How long `GET /workspaces/:id/main-checkout` waits for the runner's snapshot before answering 504. */
export const MAIN_CHECKOUT_SNAPSHOT_WAIT_SECONDS = 20;

/** Control plane → runner, on the heartbeat (`RunnerHeartbeatResponse.mainCheckoutRequests`), to a runner that
 *  declared the capability. Each is handed out once; `id` is what the answer is posted under. */
export type MainCheckoutRunnerRequest =
  | {
      id: string;
      op: 'snapshot';
      root: string;
      /** Files whose patch to read too (≤ MAIN_CHECKOUT_DIFF_PATHS_MAX), each capped at MAIN_CHECKOUT_PATCH_MAX_BYTES. */
      diffPaths?: string[];
      requestedAt: string;
      expiresAt: string;
    }
  | { id: string; op: 'action'; command: MainCheckoutActionCommand };

/** Runner → control plane: `POST /runner/main-checkout/:id/snapshot`. `error` (one line) when the read failed. */
export interface MainCheckoutSnapshotAnswer {
  snapshot?: MainCheckoutSnapshot;
  diffs?: MainCheckoutFileDiff[];
  error?: string;
}
// Runner → control plane: `POST /runner/main-checkout/:id/result` with a MainCheckoutActionResult body.

/** A branch the main checkout is on that a project lands on (§5's warning): its integration line, or the target
 *  that line is promoted into. */
export interface MainCheckoutManagedBranch {
  projectId: string;
  projectTitle: string;
  role: 'integration-line' | 'landing-target';
}

/** `GET /workspaces/:id/main-checkout`. */
export interface MainCheckoutView {
  snapshot: MainCheckoutSnapshot;
  diffs?: MainCheckoutFileDiff[];
  /** The runner declared the capability: clients draw the action buttons. */
  actionsSupported: boolean;
  /** Set when the checkout's branch is one a project lands on. */
  managedBranch: MainCheckoutManagedBranch | null;
  /** The action on this checkout still waiting for its result, if any. */
  inFlight: { requestId: string; kind: MainCheckoutActionKind } | null;
}

/** `POST /workspaces/:id/main-checkout/actions`: `pending` until the runner answers; a repeat of the same
 *  requestId answers with the first request's state and, once it has one, its result. */
export interface MainCheckoutActionAnswer {
  requestId: string;
  status: 'pending' | 'finished';
  result?: MainCheckoutActionResult;
}

/** System-event noticeKinds written into the initiating session. */
export const MAIN_CHECKOUT_NOTICE_KINDS = {
  /** End of a worktree turn: new or content-changed paths appeared in the main checkout. Replaces
   *  'shared-checkout-dirty'. Payload: MainCheckoutChangedNotice. */
  changed: 'main-checkout-changed',
  /** Every action outcome, including waiting/timeout/cancel. Payload: MainCheckoutResultNotice. */
  result: 'main-checkout-action-result',
} as const;

export interface MainCheckoutChangedNotice {
  noticeKind: typeof MAIN_CHECKOUT_NOTICE_KINDS.changed;
  /** mainCheckoutCardTitle + ' ' + mainCheckoutCardSubtitle, for clients that only draw text. */
  notice: string;
  root: string;
  branch?: string;
  /** The changed files the card lists (same cap and order as the snapshot). */
  files: Array<Pick<MainCheckoutFile, 'path' | 'status' | 'binary' | 'additions' | 'deletions'>>;
  fileCount: number;
  truncated: boolean;
  fingerprint: string;
}

export interface MainCheckoutResultNotice {
  noticeKind: typeof MAIN_CHECKOUT_NOTICE_KINDS.result;
  /** mainCheckoutResultLine(result).text. */
  notice: string;
  result: MainCheckoutActionResult;
}

// ---------------------------------------------------------------------------------------------
// Copy. Board 01 (card, bar), 02 (drawer), 03 (result lines), 04 (isolation dialogs).

export function filesCount(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}

function uncommittedFiles(n: number, other = false): string {
  return `${n} ${other ? 'other ' : ''}uncommitted ${n === 1 ? 'file' : 'files'}`;
}

function commitsCount(n: number): string {
  return `${n} ${n === 1 ? 'commit' : 'commits'}`;
}

export function shortSha(sha: string | undefined): string {
  return (sha ?? '').slice(0, 7);
}

/** "a", "a and b", "a, b and c", "a, b, c and 4 more". */
export function namePaths(paths: readonly string[]): string {
  if (paths.length <= 1) return paths[0] ?? '';
  if (paths.length <= 3) return `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1]}`;
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
}

export const MAIN_CHECKOUT_COPY = {
  label: 'Main checkout',
  moveToThisWorktree: 'Move to this worktree',
  moveToAWorktree: 'Move to a worktree',
  saveAndClean: 'Save to a rescue branch and clean',
  saveAndCleanHint:
    'Keeps everything on orbit/rescue-…, then returns the main checkout to its last commit. Ignored files are left alone.',
  askAgent: 'Ask the agent about it',
  askAgentHint: 'Puts a prompt in the composer; nothing changes until you send it.',
  leaveAsIs: 'Leave as is',
  review: 'Review',
  reviewAndCommitShort: 'Review and commit…',
  reviewMainCheckout: 'Review main checkout',
  commitMessagePlaceholder: 'Commit message',
  notShown: 'Not shown: files your .gitignore ignores. Untracked files are included.',
  targetOpenedFrom: 'The session you opened this from',
  targetBusy: 'Working now — available when this turn ends',
  cleanUpCheckout: 'Clean up checkout',
} as const;

export function mainCheckoutCardTitle(fileCount: number, truncated: boolean): string {
  return truncated
    ? `At least ${filesCount(fileCount)} changed in the main checkout during this turn`
    : `${filesCount(fileCount)} changed in the main checkout during this turn`;
}

export function mainCheckoutCardSubtitle(root: string, branch?: string): string {
  const where = branch ? `${root} on ${branch}` : root;
  return `${where}, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them.`;
}

export function mainCheckoutMoreFiles(hidden: number): string {
  return `and ${hidden} more`;
}

export function mainCheckoutTruncatedNote(limit = MAIN_CHECKOUT_FILE_LIMIT): string {
  return `Orbit stopped counting at ${limit} files.`;
}

export function mainCheckoutReviewAndCommit(branch: string): string {
  return `Review and commit to ${branch}…`;
}

export function mainCheckoutMoveHint(sessionBranch: string): string {
  return `Copies them onto ${sessionBranch}, then clears them from the main checkout. A recovery branch is saved first.`;
}

export function mainCheckoutChooseFiles(chosen: number, total: number): string {
  return `Choose files to commit · ${chosen} of ${total}`;
}

export function mainCheckoutCommitButton(chosen: number, branch: string): string {
  return `Commit ${filesCount(chosen)} to ${branch}`;
}

export function mainCheckoutUncommitted(n: number): string {
  return `${n} uncommitted`;
}

/** The bar's status text: "3 uncommitted files", "Clean · 1 commit not pushed", or both. */
export function mainCheckoutBarStatus(fileCount: number, ahead: number): string {
  const parts: string[] = [];
  parts.push(fileCount > 0 ? uncommittedFiles(fileCount) : 'Clean');
  if (ahead > 0) parts.push(`${commitsCount(ahead)} not pushed`);
  return parts.join(' · ');
}

export function mainCheckoutPushLabel(upstream: string): string {
  return `Push to ${upstream}`;
}

/** Before Commit and Push when the branch is a project's integration line or landing target. */
export function mainCheckoutManagedBranchWarning(projectTitle: string): string {
  return `This skips project ${projectTitle}'s landing check.`;
}

export const MAIN_CHECKOUT_LINK_ACTIONS = [
  'view-changes',
  'push',
  'open-in-new-session',
  'review-again',
  'ask-agent-combine',
  'ask-agent-rebase-push',
  'clean-up-checkout',
  'cancel',
] as const;
export type MainCheckoutLinkAction = (typeof MAIN_CHECKOUT_LINK_ACTIONS)[number];

export interface MainCheckoutResultLine {
  tone: 'ok' | 'refused' | 'waiting';
  /** The bold opening of `text` (text starts with it). */
  lead: string;
  /** The whole sentence, lead included. */
  text: string;
  link?: { action: MainCheckoutLinkAction; label: string };
}

/** Who is reading the line: the session it is written into. */
export interface MainCheckoutLineView {
  /** The session the line is written into. */
  sessionId?: string;
  /** move into another session: its title. */
  targetTitle?: string;
  /** false for a Shared session, which has no branch of its own to mention. Default true. */
  isolated?: boolean;
}

const NOTHING: Record<MainCheckoutActionKind, string> = {
  move: 'Nothing moved',
  commit: 'Nothing committed',
  push: 'Nothing pushed',
  rescue: 'Nothing saved',
};

const CANT: Record<MainCheckoutActionKind, string> = {
  move: "Can't move right now",
  commit: "Can't commit right now",
  push: "Can't push right now",
  rescue: "Can't save right now",
};

function line(
  tone: MainCheckoutResultLine['tone'],
  lead: string,
  rest: string,
  link?: MainCheckoutResultLine['link'],
): MainCheckoutResultLine {
  return link ? { tone, lead, text: lead + rest, link } : { tone, lead, text: lead + rest };
}

function blockedState(state: string | undefined): string {
  switch (state) {
    case 'unmerged':
      return 'has unresolved conflicts';
    case 'merge':
    case 'rebase':
    case 'revert':
      return `is in the middle of a ${state}`;
    case 'cherry-pick':
      return 'is in the middle of a cherry-pick';
    default:
      return 'is in the middle of an unfinished operation';
  }
}

function quoted(gitMessage: string | undefined): string {
  return gitMessage ? ` (“${gitMessage}”)` : '';
}

function remoteOf(upstream: string | undefined): string {
  return upstream?.split('/')[0] || 'origin';
}

/** The one line an action's outcome writes into the initiating session (board 03). */
export function mainCheckoutResultLine(
  r: MainCheckoutActionResult,
  view: MainCheckoutLineView = {},
): MainCheckoutResultLine {
  const branch = r.branch ?? 'HEAD';
  const upstream = r.upstream ?? `origin/${branch}`;
  const nothing = NOTHING[r.kind];
  const n = filesCount(r.fileCount ?? 0);
  const paths = r.paths ?? [];

  if (r.status === 'done') {
    switch (r.kind) {
      case 'move': {
        const into =
          view.targetTitle && r.targetSessionId && r.targetSessionId !== view.sessionId
            ? `into the worktree of “${view.targetTitle}”`
            : 'into this worktree';
        const after = r.remaining
          ? ` The main checkout still has ${uncommittedFiles(r.remaining, true)}.`
          : ' The main checkout is clean again.';
        return line('ok', `Moved ${n} ${into}.`, `${after} A copy of what it held is on ${r.rescueBranch}.`, {
          action: 'view-changes',
          label: 'View changes',
        });
      }
      case 'commit': {
        const tail = view.isolated === false ? '' : " This session's branch is unchanged.";
        return line(
          'ok',
          `Committed ${n} to ${branch}`,
          ` in the main checkout as ${shortSha(r.head)} “${r.subject ?? ''}”. Not pushed yet.${tail}`,
          { action: 'push', label: mainCheckoutPushLabel(upstream) },
        );
      }
      case 'push': {
        const remote = remoteOf(upstream);
        return r.remoteBefore
          ? line('ok', `Pushed ${branch} to ${remote}`, ` (${shortSha(r.remoteBefore)}..${shortSha(r.remoteAfter)}).`)
          : line('ok', `Pushed ${branch} to ${remote}`, ` as a new branch (${shortSha(r.remoteAfter)}).`);
      }
      case 'rescue':
        return line(
          'ok',
          `Saved ${n} to ${r.rescueBranch}`,
          ` and returned the main checkout to ${shortSha(r.head)}. Ignored files were left alone.`,
          { action: 'open-in-new-session', label: 'Open in a new session' },
        );
    }
  }

  const reviewAgain = { action: 'review-again', label: 'Review again' } as const;
  switch (r.code) {
    case 'FINGERPRINT_STALE':
      return line(
        'refused',
        `${nothing}:`,
        ` the main checkout changed since you looked${paths.length ? ` (${namePaths(paths)})` : ''}.`,
        reviewAgain,
      );
    case 'HEAD_MOVED':
      return line('refused', `${nothing}:`, ` ${branch} moved to ${shortSha(r.head)} since you looked.`, reviewAgain);
    case 'MOVE_CONFLICT': {
      const one = paths.length === 1;
      return line(
        'refused',
        `${nothing}:`,
        ` ${namePaths(paths)} ${one ? 'is' : 'are'} also changed in this worktree, in the same lines. ` +
          `Commit ${one ? 'it' : 'them'} to ${branch} or save ${one ? 'it' : 'them'} to a rescue branch instead, ` +
          'or ask the agent to combine them.',
        { action: 'ask-agent-combine', label: 'ask the agent to combine them' },
      );
    }
    case 'MOVE_SOURCE_CHANGED':
      return line(
        'refused',
        `Copied ${n} into this worktree but left them in the main checkout:`,
        ` ${namePaths(paths)} changed while they were moving. A copy of what it held is on ${r.rescueBranch}.`,
        { action: 'review-again', label: MAIN_CHECKOUT_COPY.reviewMainCheckout },
      );
    case 'TARGET_BUSY':
      return line('refused', `${nothing}:`, ' that session is working on a turn. Move the files when it ends.');
    case 'CHECKOUT_BLOCKED':
      return line('refused', `${CANT[r.kind]}:`, ` the main checkout ${blockedState(r.state)}.`, {
        action: 'clean-up-checkout',
        label: MAIN_CHECKOUT_COPY.cleanUpCheckout,
      });
    case 'DETACHED':
      return line('refused', `${CANT[r.kind]}:`, " the main checkout isn't on a branch (detached HEAD).");
    case 'NO_HEAD':
      return line('refused', `${CANT[r.kind]}:`, ' the main checkout has no commits yet.');
    case 'NOTHING_TO_PUSH':
      return line('refused', 'Nothing to push:', ` ${branch} is already on ${upstream}.`);
    case 'NO_REMOTE':
      return line('refused', `${nothing}:`, ` ${branch} has no upstream and the main checkout has no remote named origin.`);
    case 'PUSH_REJECTED': {
      const has = r.behind ? `has ${commitsCount(r.behind)}` : 'has commits';
      return line(
        'refused',
        'Push rejected:',
        ` ${upstream} ${has} the main checkout doesn't. Nothing was changed, and Orbit never force-pushes.`,
        { action: 'ask-agent-rebase-push', label: 'Ask the agent to rebase and push' },
      );
    }
    case 'PUSH_AUTH_FAILED':
      return line(
        'refused',
        'Push failed:',
        ` the runner's git couldn't authenticate to ${remoteOf(upstream)}${quoted(r.gitMessage)}. Your commit is still in the main checkout.`,
      );
    case 'PUSH_FAILED':
      return line(
        'refused',
        'Push failed:',
        ` git couldn't push to ${remoteOf(upstream)}${quoted(r.gitMessage)}. Your commit is still in the main checkout.`,
      );
    case 'RESCUE_FAILED':
      return line(
        'refused',
        `${nothing}:`,
        ` Orbit couldn't save the main checkout to a rescue branch first${quoted(r.gitMessage)}. The main checkout was left as it was.`,
      );
    case 'ACTION_IN_FLIGHT':
      return line(
        'refused',
        `${nothing}:`,
        ' another action on this main checkout is still running. Try again when it finishes.',
      );
    case 'RUNNER_OFFLINE':
      return line(
        'waiting',
        'Waiting for the runner',
        ` — ${r.runnerName ?? 'the runner'} hasn't checked in for ${r.minutes ?? 0} min. ` +
          "Nothing has been changed; this runs when it's back, or you can cancel.",
        { action: 'cancel', label: 'Cancel' },
      );
    case 'TIMEOUT':
      return line(
        'refused',
        'Timed out:',
        ` ${r.runnerName ?? 'the runner'} didn't answer within ${r.minutes ?? 0} min, so Orbit stopped waiting. ` +
          'If it ran the action anyway, its result will appear here.',
      );
    case 'CANCELLED':
      return line('refused', 'Cancelled:', ' nothing was changed.');
    default:
      return line('refused', `${nothing}.`, '');
  }
}

// Board 04: switching worktree isolation.

export const WORKTREE_ISOLATION_DIALOG_COPY = {
  turnOnTitle: 'Turn on worktree isolation?',
  turnOffTitle: 'Turn off worktree isolation?',
  unchanged: 'Nothing in the checkout is changed. Sessions already running keep working in the main checkout until they end.',
  unseen: "Orbit can't see this checkout right now.",
  reviewFiles: 'Review files',
  cancel: 'Cancel',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  cleanUpCheckout: 'Clean up checkout',
} as const;

export function worktreeIsolationDirtyBody(root: string, fileCount: number, branch: string, head: string): string {
  return (
    `The main checkout ${root} has ${uncommittedFiles(fileCount)}. ` +
    `New sessions start from the last commit on ${branch} (${shortSha(head)}), so they won't see those files.`
  );
}

export function worktreeIsolationStuckBody(root: string, state: string): string {
  const what = state === 'unmerged' ? 'has unresolved conflicts' : `is stuck in a ${state}`;
  return `The main checkout ${root} ${what} — new sessions can be created, but merges stay blocked until it's cleaned up.`;
}

export function worktreeIsolationOffBody(root: string, unmergedSessions: number): string {
  const keep =
    unmergedSessions === 1
      ? 'The 1 session with an unmerged worktree keeps it — merge or discard it from the session as before.'
      : `The ${unmergedSessions} sessions with unmerged worktrees keep them — merge or discard them from each session as before.`;
  return `New sessions will work directly in ${root}. ${keep}`;
}
