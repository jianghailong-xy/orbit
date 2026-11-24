import type { IntegrationCheckResult } from '@orbit/shared';

/**
 * The fix turn of a session's Merge whose pull request failed a required check (docs/design/protected-branch-landing.md
 * §4.6, D5 as the owner ruled on 2026-11-23): the failing check's log, handed to the session as one platform turn.
 * Its end merges again (`mergeAfterTurnAt`), so the session's next commit updates the same pull request.
 *
 * Keyed by the pull request and the head GitHub ran the check on: `pull-request-fix:v1:<pull request id>:<head sha>`.
 * One failed head is one turn however often it is read, and a pull request gets at most {@link SESSION_FIX_ROUNDS}.
 * Spelled here rather than in the door, so the turn-key guard (watch-turn-key.ts) can reserve it without importing
 * GitHub code.
 */
export const PULL_REQUEST_FIX_TURN_KEY_PREFIX = 'pull-request-fix:v1:';

/** D5: how many fix turns one session's pull request gets. */
export const SESSION_FIX_ROUNDS = 2;

export function pullRequestFixTurnPrefix(pullRequestId: string): string {
  return `${PULL_REQUEST_FIX_TURN_KEY_PREFIX}${pullRequestId}:`;
}

export function pullRequestFixTurnId(pullRequestId: string, headSha: string): string {
  return `${pullRequestFixTurnPrefix(pullRequestId)}${headSha}`;
}

/** The heading the server puts above a GitHub check's failure lines (projects/landing-fix-turn.ts uses the same). */
const FAILURE_LINES_HEADING = 'Failure lines from the whole output:';

/** The lines under the failure heading of a check's stored tail. */
function failureLines(tail: string): string[] {
  const at = tail.lastIndexOf(FAILURE_LINES_HEADING);
  if (at < 0) return [];
  return tail.slice(at + FAILURE_LINES_HEADING.length).split('\n').filter((line) => line.trim() !== '');
}

/** The turn's words (§4.5's pull request text, for a session's own Merge). Product copy: English. */
export function pullRequestFixMessage(input: {
  title: string | null;
  targetBranch: string;
  pullRequest: { number: number; url: string };
  headSha: string;
  checks: IntegrationCheckResult[];
  round: number;
  rounds: number;
}): string {
  const target = input.targetBranch;
  const which = `pull request #${input.pullRequest.number}`;
  const failed = input.checks.flatMap((check) => {
    const lines = failureLines(check.outputTail);
    return [
      `The required check "${check.command}" failed on ${which} (${input.headSha.slice(0, 7)}):`,
      ...(lines.length > 0 ? lines : ['(GitHub gave no failure lines; the full log is at the link below)']),
      `Full log: ${check.github?.url ?? input.pullRequest.url}`,
      '',
    ];
  });
  return [
    `Orbit could not merge ${input.title ? `"${input.title}"` : 'your work'} into ${target}.`,
    '',
    ...failed,
    `Nothing was merged. ${target} is unchanged, and ${which} stays open: ${input.pullRequest.url}`,
    '',
    'Fix it on your own branch, in this checkout:',
    '1. Run what failed until it passes.',
    '2. Commit, then end your turn.',
    '',
    `When this turn ends, Orbit merges again: your commit updates ${which}, and GitHub runs the checks again. `
      + `Do not push ${target}.`,
    'If this is not yours to fix, end your turn without committing and say why.',
    `This is fix round ${input.round} of ${input.rounds}.`,
  ].join('\n');
}
