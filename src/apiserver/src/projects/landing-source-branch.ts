import type { Prisma } from '@prisma/client';

/**
 * Which of a task's work sessions a landing is handed: the branch `project_integration_job.source_ref`
 * names, and the branch `project_promotion.source_ref` names on a MAIN line.
 *
 * THE BUG THIS EXISTS FOR (2026-09-23, project `34Tq39ByZ0rV4c6pJkfw7`)
 * -------------------------------------------------------------------
 * Task `34TqaiSUMbQfgTGgyTuNK` ran three sessions. The first died on a 429 after zero turns; the
 * second did the work over 57 turns and committed it (`2cf6369d7`); the third was a retry that died
 * on a 429 after one turn and committed nothing. The rule here used to be "the newest work session",
 * read as `ORDER BY created_at DESC LIMIT 1`, so the DONE that ended the task handed the line the
 * THIRD session's branch: `orbit/web-5-markdown-orbit-2a09d2`, whose tip was the upstream commit it
 * forked at. The line answered ALREADY_LANDED — the branch was an ancestor of the target, trivially —
 * wrote a receipt for a landing that moved nothing, and the promotion card counted the task as
 * carrying work the merge did not contain. The branch that held the work was never offered to the
 * line at all. A session that died before it produced anything must not stand in for the one that
 * produced the delivery.
 *
 * WHAT "PRODUCED SOMETHING" IS, AND WHY IT IS THIS COLUMN
 * ------------------------------------------------------
 * Whether a branch has commits of its own is a fact about a repository, and neither this module nor
 * any other in the API server has a checkout to read it from. What the row carries instead is what
 * the runner reported about the session's worktree — `changed_files`, the per-file diff summary of
 * the branch against its base — and an empty one is the runner saying, in its own words, that the
 * session left nothing: measured on this deployment, the two sessions that died on a 429 report `[]`
 * and the one that delivered reports eight files. A session that never reported one at all (null)
 * counts the same way: no work reported is not work.
 *
 * The fallback is deliberate and is the old rule: when NO session of the task reported anything, the
 * newest one is handed over as before. Such a task has nothing of its own to land, and the line still
 * has to be told so — the answer it gives (`NOTHING_TO_LAND`) is what §1.4's landing lane reads to
 * let zero-commit work out of a criterion's roll-up, so a DONE that queued no landing at all would
 * strand the dependents it releases.
 */

/**
 * How many of a task's work sessions the callers read. A task with more than this many finished
 * branches is one whose recent history is enough to pick from, and the read stays bounded.
 */
export const LANDING_SESSION_CANDIDATES = 20;

/** The columns a caller must select for {@link landingWorkSession} to decide anything. */
export const LANDING_WORK_SESSION_SELECT = {
  id: true,
  branch: true,
  isolationStatus: true,
  assignedRunnerId: true,
  changedFiles: true,
} as const;

/** A work session, as far as the choice between them is concerned. */
export interface LandingCandidateSession {
  changedFiles: Prisma.JsonValue | null;
}

/**
 * Whether this session's finalize reported any work: a non-empty `changed_files`.
 *
 * A JSON array with at least one file in it, which is exactly what a runner reports for a branch
 * that moved. `[]` — the live-snapshot spelling of "this worktree is clean" — and null are both "no
 * work reported".
 */
export function sessionReportedWork(session: LandingCandidateSession): boolean {
  return Array.isArray(session.changedFiles) && session.changedFiles.length > 0;
}

/**
 * The session to hand the line: the newest that reported work, else the newest there is.
 *
 * `sessions` is in the order its reader fetched it — newest first — and the caller has already
 * filtered to the sessions that can carry work at all (a worktree and a branch, §1.1). The tie is
 * broken by the reader's ORDER BY, which is `created_at DESC, id DESC`, the same spelling every
 * other newest-session read in this tree uses.
 */
export function landingWorkSession<T extends LandingCandidateSession>(
  sessions: readonly T[],
): T | undefined {
  return sessions.find(sessionReportedWork) ?? sessions[0];
}
