import type { SourceFixAction } from '@orbit/shared';

/**
 * A refused start's one-line diagnosis, per fixAction — the sentence that says which of §10.1's ten
 * situations this is, before the shared next step says what to do about it.
 *
 * Two readers, one table: the card over a conversation whose run never started
 * (components/RunNeverStartedCard) and the project page's SOURCE_UNRESOLVED blocker
 * (components/ProjectBlockers). Both are looking at the same refusal — the blocker's `detail` and
 * the session's `sourceRefusalDetail` carry the same three fields (`code`, `fixAction`, `ref`), and
 * two tables would be free to describe one of them differently on the two screens.
 *
 * The fixAction itself is NEVER derived here: the server pairs the code with it (`SOURCE_FIX_ACTIONS`
 * in @orbit/shared, written into `sourceRefusalDetail` and into `task.dispatchRefusal`), and this
 * only says how to phrase what it said. A code from a newer contract than this build — or a payload
 * with no pairing at all — falls back to the fact rather than to a guess.
 */
export const SOURCE_FIX_ACTION_WHY: Readonly<Record<SourceFixAction, string>> = {
  BIND_CODEBASE: 'This project has no repository bound to it, so there is nothing to start from.',
  FIX_WORKSPACE_REPO:
    'The workspace this run belongs to is not the repository this project starts from.',
  RETRY_OR_FIX_CREDENTIALS: 'The runner could not reach the repository this ref lives in.',
  FIX_REF:
    'Its baseline is a branch that doesn’t exist yet — this project’s integration line has not been created.',
  RESTORE_COMMIT: 'The commit this run was pinned to is missing from the runner’s repository.',
  SYNC_INTEGRATION_LINE:
    'A prerequisite has landed, but the line this run starts from has not absorbed it yet.',
  ENABLE_ISOLATION: 'The runner could not create an isolated worktree on the pinned commit.',
  UPGRADE_RUNNER: 'This runner is too old to start from a pinned project commit.',
  START_NEW_RUN: 'That baseline is closed to a second resolution, so this run cannot be restarted.',
  FIX_CODEBASE_CONFIG: 'This project’s repository binding is not valid.',
};

/** The one a newer server named, or a code this build cannot phrase. */
const SOURCE_FIX_ACTION_WHY_OTHER = 'The runner refused this run’s baseline before it started.';

/** What to say about a refusal whose fixAction the server (or this build) may not have named. */
export function sourceRefusalWhy(fixAction: string | null | undefined): string {
  return (fixAction && SOURCE_FIX_ACTION_WHY[fixAction as SourceFixAction]) || SOURCE_FIX_ACTION_WHY_OTHER;
}
