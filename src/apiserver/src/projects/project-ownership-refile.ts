/**
 * Unit L6: the supported repair for a task that is counting towards the wrong goal.
 *
 * The gate stops the run. It does not fix anything, and it must not: which project owns a piece of
 * work is the one question L1 refuses to let a coordinator answer about somebody else's goal, so
 * the loop silently moving the task would be the incident again with better manners. What a person
 * gets instead is ONE operation with one outcome, and this module is the decision behind it.
 *
 * WHAT THE REPAIR IS
 * ------------------
 * File a REPLACEMENT task in the project whose coordinator filed the work, and abandon the
 * original. Not a move — `task.project_id` is what acceptance, scheduling, liveness and concurrency
 * all read, and rewriting it in place would silently re-point every fact already recorded against
 * it. Not a supersession either: 0128's guard requires a successor to be in the SAME project, and
 * that is not an obstacle to route around — it is the guard saying, correctly, that "this attempt
 * was replaced by a better one" and "this work was filed in the wrong place" are different claims.
 *
 * So the mapping is provenance, one-directional and queryable both ways: the replacement's
 * `source_task_id` names the original and its `trigger_event` says why. Migration 0156's partial
 * unique index over that pair is what makes the repair idempotent without a lock — a second attempt
 * loses on the index and reads back what the first one wrote.
 *
 * WHAT IT REFUSES, AND WHY THOSE ARE REFUSALS RATHER THAN BRANCHES
 * ---------------------------------------------------------------
 * Only work that never started is repaired automatically. A run that happened is a fact about the
 * world — a Session with a transcript, a branch, a merge receipt, an outcome somebody read — and
 * the repair has exactly nothing to say about it. Abandoning a task that ran would not delete those
 * facts; it would leave them attached to a task whose recorded ending is "dropped on purpose",
 * which is a lie about work that was actually done.
 *
 * A live run is refused for a second reason on top of that one: ending it would mean cancelling
 * somebody's session to make an audit tidy. The project instruction is explicit that a run reaches
 * a terminal status OF ITS OWN, and 0130's `task_supersession_live_session_guard` says the same
 * thing in the database. So the answer is to freeze — the blocker stays open, owned by USER, and
 * the repair becomes available when the run ends on its own terms.
 *
 * Pure: no clock, no database, no Nest.
 */

import type { TaskOwnershipAnswer } from './project-ownership-gate';

/** The `trigger_event` a replacement carries. Migration 0156's partial unique index keys on it. */
export const OWNERSHIP_REFILE_TRIGGER = 'project.ownership_refiled' as const;

export const REFILE_REFUSALS = [
  /** The gate does not refuse this task, so there is nothing here to repair. */
  'NOT_MISFILED',
  /** A run is live, or the task is IN_PROGRESS. Freeze and wait for it to end by itself. */
  'TASK_RUNNING',
  /** Work happened here, or the task already reached an end. Its result is not the repair's to edit. */
  'TASK_HAS_RUN_RESULT',
  /** The project that should own the work is settled. §4 R8 / unit L5: reopen it first. */
  'TARGET_NOT_OPEN',
  /** Nothing recorded which project filed it, so nobody can say where the replacement goes. */
  'TARGET_UNKNOWN',
] as const;
export type RefileRefusal = (typeof REFILE_REFUSALS)[number];

export interface RefileFacts {
  /** The gate's answer for this task, from the same decision every start path uses. */
  ownership: TaskOwnershipAnswer;
  taskStatus: string;
  /** Sessions on this task in PENDING / RUNNING / AWAITING_INPUT / INTERRUPTED. */
  liveSessionCount: number;
  /** Sessions on this task in ANY state — the test for "did work ever happen here". */
  sessionCount: number;
  /** Status of the project the replacement would land in; null when that project is gone. */
  targetProjectStatus: 'OPEN' | 'DONE' | 'CANCELLED' | null;
  /** A replacement this repair already filed, if one exists. Migration 0156 allows at most one. */
  existingReplacementTaskId: string | null;
}

export type RefilePlan =
  /** Already done. The idempotent answer, and it is an answer rather than an error. */
  | { action: 'ALREADY_REFILED'; replacementTaskId: string; replacementProjectId: string | null }
  /**
   * `replacementProjectId` is the scope that FILED the work — never a project the caller named.
   * Letting the caller choose would put "which project owns this" back in the hands of whoever is
   * making the write, which is the authority the whole contract exists to withhold. Somebody who
   * believes the work really belongs where it sits has a different operation for that, and it is
   * L4's: declare the crossing and answer it.
   */
  | { action: 'REFILE'; replacementProjectId: string; abandonedProjectId: string | null }
  | { action: 'REFUSE'; reason: RefileRefusal; message: string };

/** Statuses that mean the task itself has already reached an end, whatever its sessions say. */
const SETTLED = new Set(['DONE', 'CANCELLED', 'FAILED']);

export function planOwnershipRefile(facts: RefileFacts): RefilePlan {
  const refuse = (reason: RefileRefusal, message: string): RefilePlan =>
    ({ action: 'REFUSE', reason, message });

  // FIRST, ahead of every other rule including "is this still mis-filed". A completed repair
  // abandons the original, and an abandoned task is out of the gate's scope — so asking the gate
  // first would make the second call to a successful repair answer `NOT_MISFILED`, which reads as
  // "you were wrong about this" rather than "this is already done". Idempotence is not a retry
  // convenience here: it is what two apiservers, or one user double-clicking, actually do.
  if (facts.existingReplacementTaskId) {
    return {
      action: 'ALREADY_REFILED',
      replacementTaskId: facts.existingReplacementTaskId,
      replacementProjectId: facts.ownership.fromProjectId,
    };
  }
  if (!facts.ownership.refuses) {
    return refuse(
      'NOT_MISFILED',
      'this task is filed in the project that owns it — there is nothing to refile',
    );
  }
  const target = facts.ownership.fromProjectId;
  if (!target) {
    return refuse(
      'TARGET_UNKNOWN',
      'nothing recorded which project this task was filed under, so there is nowhere to refile it to',
    );
  }
  // Live FIRST among the two run refusals, because it is the more specific fact and the two have
  // different remedies: a live run ends by itself and the repair becomes available, while a
  // finished one never will and needs a person to decide something else.
  if (facts.liveSessionCount > 0 || facts.taskStatus === 'IN_PROGRESS') {
    return refuse(
      'TASK_RUNNING',
      'this task is running: refiling it would mean ending somebody\'s session to tidy an audit. '
      + 'Wait for the run to reach a terminal status of its own, then refile',
    );
  }
  if (facts.sessionCount > 0 || SETTLED.has(facts.taskStatus)) {
    return refuse(
      'TASK_HAS_RUN_RESULT',
      'work has already been done under this task, and the repair does not rewrite real run '
      + 'results: file the follow-up work in the owning project yourself, and decide what this '
      + 'task\'s outcome means',
    );
  }
  if (facts.targetProjectStatus !== 'OPEN') {
    return refuse(
      'TARGET_NOT_OPEN',
      facts.targetProjectStatus === null
        ? 'the project this task was filed under no longer exists, so the replacement has nowhere '
          + 'to go — move the task into the project that owns the work instead'
        : 'the project that owns this work is settled and takes no new work: reopen it first, '
          + 'which starts a new acceptance epoch',
    );
  }
  return {
    action: 'REFILE',
    replacementProjectId: target,
    abandonedProjectId: facts.ownership.toProjectId,
  };
}
