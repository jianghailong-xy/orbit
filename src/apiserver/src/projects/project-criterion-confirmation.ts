/**
 * A criterion met by confirmation (migration 0545, owner decisions 2026-11-11).
 *
 * A project criterion is met either by the work filed under it — `TASKS`, the rule
 * `project-criterion-satisfaction.ts` has always applied, and still the default — or by
 * `CONFIRMATION`: somebody saying it holds. Three kinds of somebody may: the account owner, the
 * project's coordinator, or an Agent check, a run started for the criterion that reads its
 * `verificationMethod` and reports PASS or FAIL.
 *
 * This file is the pure half: which confirmation row, if any, answers for a criterion today. The
 * doors that write those rows are `project-criterion-confirmation.service.ts`.
 *
 * THE RULE
 * --------
 * Only rows about the criterion's CURRENT revision count, and only rows nobody withdrew. Among
 * those, the newest one that has settled (CONFIRMED, or an Agent check's FAILED) decides — the same
 * "a newer check re-opens the question" rule `servingTaskSettled` applies to a task's checks. So:
 *
 *  - CONFIRMED  the newest settled row is a confirmation: the criterion is met.
 *  - CHECK_FAILED  the newest settled row is an Agent check that reported FAIL: not met, and the
 *    attempt is named.
 *  - STALE  nothing settled on this revision, but a confirmation of an earlier revision stands
 *    un-withdrawn: the wording or the method moved after somebody confirmed it. Not met.
 *  - UNCONFIRMED  nobody has confirmed any revision. Not met.
 *
 * An Agent check still running (`PENDING`) settles nothing and is reported beside the answer.
 */

import type { Prisma } from '@prisma/client';

export type CriterionSatisfiedByValue = 'TASKS' | 'CONFIRMATION';
export type CriterionConfirmerKindValue = 'OWNER' | 'COORDINATOR' | 'AGENT_CHECK';
export type CriterionConfirmationOutcomeValue = 'PENDING' | 'CONFIRMED' | 'FAILED';

export const CRITERION_SATISFIED_BY: readonly CriterionSatisfiedByValue[] = ['TASKS', 'CONFIRMATION'];

/** One confirmation row, as the fold reads it. */
export interface CriterionConfirmationFacts {
  id: string;
  revision: number;
  confirmerKind: CriterionConfirmerKindValue;
  outcome: CriterionConfirmationOutcomeValue;
  sessionId: string | null;
  checkTaskId: string | null;
  note: string | null;
  attachmentIds: string[];
  /** The criterion's wording and verification method at `revision` (0555); null on an older row. */
  criterionText?: string | null;
  criterionVerificationMethod?: string | null;
  createdAt: Date;
  settledAt: Date | null;
  withdrawnAt: Date | null;
}

/** One confirmation, as a reader is shown it: who, when, on which revision, and what they said. */
export interface CriterionConfirmationView {
  id: string;
  revision: number;
  confirmerKind: CriterionConfirmerKindValue;
  outcome: CriterionConfirmationOutcomeValue;
  /** The coordinator conversation that confirmed, or the Agent check's run. Null for the owner. */
  sessionId: string | null;
  /** The Agent check's task. Null for the owner and the coordinator. */
  checkTaskId: string | null;
  note: string | null;
  attachmentIds: string[];
  /** When it was said: the report of an Agent check, or the write of the other two. */
  at: Date;
  /** The criterion's wording and verification method at `revision`, as they stood when it was
   *  confirmed — what a STALE row's "What changed" shows beside the current ones. Null on a row
   *  written before 0555 whose revision had already moved. */
  criterionText: string | null;
  criterionVerificationMethod: string | null;
}

export type CriterionConfirmationState = 'CONFIRMED' | 'CHECK_FAILED' | 'STALE' | 'UNCONFIRMED';

/** Where one CONFIRMATION criterion stands. */
export interface CriterionConfirmationStanding {
  state: CriterionConfirmationState;
  /** The row the state is about: the standing confirmation, the failed check, or the stale
   *  confirmation of an earlier revision. Null exactly when UNCONFIRMED. */
  current: CriterionConfirmationView | null;
  /** True exactly when STALE: `current` names a revision that is no longer the criterion's. */
  stale: boolean;
  /** An Agent check of the current revision still running, if there is one. */
  checkRunning: CriterionConfirmationView | null;
}

/** The SELECT the fold needs, spelled once for every reader. Withdrawn rows never count, so they
 *  are not read; newest first. */
export const CRITERION_CONFIRMATION_SELECT = {
  where: { withdrawnAt: null },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  select: {
    id: true,
    revision: true,
    confirmerKind: true,
    outcome: true,
    sessionId: true,
    checkTaskId: true,
    note: true,
    attachmentIds: true,
    criterionText: true,
    criterionVerificationMethod: true,
    createdAt: true,
    settledAt: true,
    withdrawnAt: true,
  },
} satisfies Prisma.ProjectAcceptanceCriterionDefinition$confirmationsArgs;

export function criterionConfirmationView(row: CriterionConfirmationFacts): CriterionConfirmationView {
  return {
    id: row.id,
    revision: row.revision,
    confirmerKind: row.confirmerKind,
    outcome: row.outcome,
    sessionId: row.sessionId,
    checkTaskId: row.checkTaskId,
    note: row.note,
    attachmentIds: row.attachmentIds,
    at: row.settledAt ?? row.createdAt,
    criterionText: row.criterionText ?? null,
    criterionVerificationMethod: row.criterionVerificationMethod ?? null,
  };
}

function settledTime(row: CriterionConfirmationFacts): number {
  return (row.settledAt ?? row.createdAt).getTime();
}

/** The rule above, over a criterion's rows in any order. */
export function criterionConfirmationStanding(
  revision: number,
  rows: ReadonlyArray<CriterionConfirmationFacts>,
): CriterionConfirmationStanding {
  const live = rows.filter((row) => row.withdrawnAt === null);
  const newestFirst = (a: CriterionConfirmationFacts, b: CriterionConfirmationFacts) =>
    settledTime(b) - settledTime(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const current = live.filter((row) => row.revision === revision);
  const running = current
    .filter((row) => row.outcome === 'PENDING')
    .sort(newestFirst)[0];
  const checkRunning = running ? criterionConfirmationView(running) : null;
  const decided = current.filter((row) => row.outcome !== 'PENDING').sort(newestFirst)[0];
  if (decided) {
    return {
      state: decided.outcome === 'CONFIRMED' ? 'CONFIRMED' : 'CHECK_FAILED',
      current: criterionConfirmationView(decided),
      stale: false,
      checkRunning,
    };
  }
  const earlier = live
    .filter((row) => row.revision < revision && row.outcome === 'CONFIRMED')
    .sort(newestFirst)[0];
  if (earlier) {
    return { state: 'STALE', current: criterionConfirmationView(earlier), stale: true, checkRunning };
  }
  return { state: 'UNCONFIRMED', current: null, stale: false, checkRunning };
}
