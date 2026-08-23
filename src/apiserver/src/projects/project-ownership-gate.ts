/**
 * Unit L6: the run-time ownership gate — the second question every start path asks.
 *
 * The first question is the one everything already asks: *is this task in my project?* L3 and L4
 * made sure the answer can only become yes lawfully, from now on. This module is about the rows
 * where it became yes before they landed, or in `observe` mode, or through a path nobody has
 * thought of yet — because for those rows the answer is still yes, and yes is all a dispatcher
 * looks at. A mis-filed task is indistinguishable from a deliberate one exactly where it matters:
 * at the moment it runs.
 *
 * So the gate asks a second question — *who put it there, and what were they coordinating when
 * they did* — and compares the two answers. `task.creator_coordinator_project_id` (migration 0156)
 * is the first; `task.project_id` is the second. They disagree only when the goal this work counts
 * towards is not the goal it was filed under, which is the incident, stated as a predicate.
 *
 * WHAT IT DELIBERATELY DOES NOT REFUSE
 * ------------------------------------
 * Three things, and each of them is a class of ordinary work that a stricter rule would stop:
 *
 *   - **an unrecorded scope.** NULL is "nobody wrote a claim down", not "the claim was none". Every
 *     task a user filed, every task written outside a session, and every pre-0156 row the backfill
 *     could not attribute unambiguously is NULL — and refusing those would be refusing the whole
 *     product on the strength of a column that did not exist when they were written.
 *   - **a task under no project.** The gate is about work counting towards the WRONG goal. A task
 *     that counts towards none has no project to block, no coordinator to refuse it and no
 *     acceptance it can distort; §2's write surface is about ownership claims, and this is the
 *     absence of one. (What a scoped writer filing project-less work SHOULD get is L3's
 *     `UNMAPPED_PROJECT_WORK`, at creation, where somebody can still answer it.)
 *   - **a generation that moved.** A rotation replaces who coordinates a project; it does not move
 *     work between projects. The generation is recorded and shown, because "which run of the
 *     coordinator did this" is the first thing a person investigating asks, but a gate that refused
 *     on it would refuse every task filed before any rotation — which is to say, eventually, all of
 *     them.
 *
 * And one thing it does not refuse because somebody already answered it: an APPLIED handoff
 * approval (unit L4) that names this task and lands it in the project it is in. That is precisely
 * the difference between a violation and a request — R7 vs R9–R14 — carried forward to run time. A
 * crossing a person said yes to is not a mis-filing, and the row that says so is the same row L4
 * writes.
 *
 * Pure: no clock, no database, no Nest. What the caller supplies is what the server read.
 */

import {
  PROJECT_BLOCKER_POLICY,
  projectBlockerConditionVersion,
  projectBlockerDedupeKey,
  type ObservedBlockerCondition,
} from './project-blocker';

/** The blocker this gate raises, named once so the kind and the gate cannot drift apart. */
export const OWNERSHIP_MISMATCH_BLOCKER = 'PROJECT_OWNERSHIP_MISMATCH' as const;

/**
 * The refusal code the start paths report. Its own code, not one of L1's four: those are
 * admission-time answers about a write that has not happened, and this is about one that did — a
 * caller told `PROJECT_SCOPE_MISMATCH` would reasonably retry with a different project, and there
 * is nothing here for them to retry.
 */
export const OWNERSHIP_MISMATCH_REFUSAL = 'PROJECT_OWNERSHIP_MISMATCH' as const;

export const TASK_OWNERSHIP_VERDICTS = [
  /** The scope that filed it is the project that owns it. The ordinary case. */
  'OWNED',
  /** No scope was recorded, or no project owns the work. Nothing to compare, nothing to refuse. */
  'UNATTRIBUTED',
  /** They differ, and a person said yes to the crossing that made them differ (unit L4). */
  'CROSSING_APPROVED',
  /** They differ, and nobody authorised it. This is the one that stops a run. */
  'MISMATCH',
] as const;
export type TaskOwnershipVerdict = (typeof TASK_OWNERSHIP_VERDICTS)[number];

/** Everything the decision reads, all of it server-derived. */
export interface TaskOwnershipFacts {
  taskId: string;
  /** Which goal this work counts towards today. */
  projectId: string | null;
  /** The scope the row was admitted under (migration 0156). NULL = no claim recorded. */
  creatorCoordinatorProjectId: string | null;
  /** Decimal string, as every BigInt column crosses this boundary. NULL = none recorded. */
  creatorCoordinatorGeneration: string | null;
  /**
   * An APPLIED `ProjectHandoffApproval` naming this task whose `toProjectId` is where the task now
   * is. Supplied by the caller because it is a second table; decided here so that every start path
   * spends the same rule on it.
   */
  approvedCrossing: boolean;
}

export interface TaskOwnershipAnswer {
  verdict: TaskOwnershipVerdict;
  /** True for `MISMATCH` and nothing else. The one field a start path has to read. */
  refuses: boolean;
  /** The project the write was made under — the source of the crossing that never was declared. */
  fromProjectId: string | null;
  /** The project the work landed in, which is the one whose goal it is counting towards. */
  toProjectId: string | null;
  creatorCoordinatorGeneration: string | null;
}

export function decideTaskOwnership(facts: TaskOwnershipFacts): TaskOwnershipAnswer {
  const from = facts.creatorCoordinatorProjectId;
  const to = facts.projectId;
  const answer = (verdict: TaskOwnershipVerdict): TaskOwnershipAnswer => ({
    verdict,
    refuses: verdict === 'MISMATCH',
    fromProjectId: from,
    toProjectId: to,
    creatorCoordinatorGeneration: facts.creatorCoordinatorGeneration,
  });
  if (!from || !to) return answer('UNATTRIBUTED');
  if (from === to) return answer('OWNED');
  if (facts.approvedCrossing) return answer('CROSSING_APPROVED');
  return answer('MISMATCH');
}

/**
 * The sentence a refused start path says, in the two words a person can act on: which project the
 * work was filed FROM, and which one it is sitting in.
 *
 * Ids arrive already public (Base62) — the gate does not encode, because half its callers are
 * inside a transaction holding raw UUIDs and the other half are not, and one function that
 * sometimes encodes is how a raw UUID reaches a user-facing string.
 */
export function ownershipMismatchMessage(answer: TaskOwnershipAnswer): string {
  return (
    `this task was filed by the coordinator of project ${answer.fromProjectId} but is `
    + `counted towards project ${answer.toProjectId}, and no approved handoff explains the `
    + 'crossing — it cannot run until somebody says which project owns the work'
  );
}

/** What the blocker's `condition_version` is computed from (TF2), and nothing else. */
export interface OwnershipMismatchFacts {
  from: string;
  to: string;
  generation: string | null;
}

/**
 * §11.4's detector output for one mis-filed task.
 *
 * `subjectId` is the task, so the dedupe key is `PROJECT_OWNERSHIP_MISMATCH:TASK:<task>` and a
 * project holding four mis-filed tasks gets four rows rather than one that keeps changing its mind
 * about which task it is about. The condition version carries the PAIR, so a task that is refiled —
 * or moved again — is visibly a different condition rather than the same one seen once more.
 *
 * Owner, recovery, severity and required action are NOT set here: they are the kind's policy row,
 * and `planProjectBlockers` reads them from it. A detector that carried its own copy would be a
 * second place for §11.2 to be true.
 */
export function ownershipMismatchCondition(input: {
  /** Base62, like every id in a decision snapshot. */
  taskPublicId: string;
  taskTitle: string;
  fromProjectPublicId: string;
  toProjectPublicId: string;
  generation: string | null;
  /** The replacement filed by the supported repair, if one exists yet. Display only. */
  replacementTaskPublicId?: string | null;
}): ObservedBlockerCondition {
  const facts: OwnershipMismatchFacts = {
    from: input.fromProjectPublicId,
    to: input.toProjectPublicId,
    generation: input.generation,
  };
  return {
    kind: OWNERSHIP_MISMATCH_BLOCKER,
    subjectType: 'TASK',
    subjectId: input.taskPublicId,
    facts,
    detail: {
      taskId: input.taskPublicId,
      title: input.taskTitle,
      // The two ends, named in the row rather than left to be reconstructed. BL0's third and fourth
      // questions — what is this about, and what has to happen — are answerable from the row alone.
      fromProjectId: input.fromProjectPublicId,
      toProjectId: input.toProjectPublicId,
      creatorCoordinatorGeneration: input.generation,
      requiredAction: PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER].requiredAction,
      owner: PROJECT_BLOCKER_POLICY[OWNERSHIP_MISMATCH_BLOCKER].owner,
      replacementTaskId: input.replacementTaskPublicId ?? null,
    },
  };
}

/** The row's identity, exposed so a writer outside the reconcile pass computes the same one. */
export function ownershipMismatchDedupeKey(taskPublicId: string): string {
  return projectBlockerDedupeKey(OWNERSHIP_MISMATCH_BLOCKER, 'TASK', taskPublicId);
}

export function ownershipMismatchConditionVersion(
  taskPublicId: string,
  facts: OwnershipMismatchFacts,
): string {
  return projectBlockerConditionVersion(
    OWNERSHIP_MISMATCH_BLOCKER, 'TASK', taskPublicId, facts,
  );
}
