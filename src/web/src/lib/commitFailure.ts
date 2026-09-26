/**
 * How the worktree bar speaks about a commit that failed — SessionOutputs' failure panel, the
 * "Commit failed" card, and what "Resolve in session" hands the session. The runner sends two
 * things: git's own words (`commitError`) and, when it can, its own plain sentence about why and
 * what to do (`commitResultMessage` on an error). A lock problem is named as one: git's refusal
 * names index.lock whatever language it speaks, which is how the runner itself tells.
 */
export interface CommitFailureCopy {
  headline: string;
  why: string;
  /** git's words, for "Show git output"; null when they would only repeat `why`. */
  gitOutput: string | null;
}

/** For a lock failure reported by a runner too old to explain it. */
const LOCK_BUSY =
  "Another git process holds this worktree's index lock. Retry once it finishes, or hand it to the session.";

export function commitFailureCopy(
  commitError?: string | null,
  summary?: string | null,
): CommitFailureCopy {
  const raw = commitError?.trim() ?? '';
  const lockBusy = raw.includes('index.lock');
  const firstLine = raw.split('\n').find((line) => line.trim())?.trim() ?? '';
  const why = summary?.trim() || (lockBusy ? LOCK_BUSY : firstLine) || 'Commit failed — try again.';
  return {
    headline: lockBusy ? "Couldn't commit — git is busy in this worktree" : "Couldn't commit",
    why,
    gitOutput: raw && raw !== why ? raw : null,
  };
}

/** What "Resolve in session" asks the session's agent to do about a failed commit. */
export function resolveCommitPrompt(branch: string, why: string): string {
  return (
    'The Commit button on the worktree bar could not commit this session\'s work. It said: "' +
    why +
    '"\n\n' +
    "You're in this session's isolated git worktree, checked out on " +
    branch +
    '. Find out what stopped the commit and clear it: let a git command that is still running' +
    ' here finish; an index.lock that no process has open was left behind by a git that died and' +
    ' is safe to remove. Then commit the work on this branch with a message that describes it.' +
    ' Do not push.'
  );
}
