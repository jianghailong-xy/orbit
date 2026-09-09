import { ProjectStatus } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import {
  criteriaFromDefinitions,
  standardSetConfirmationStanding,
  standardSetVersion,
  type RecordedStandardSetConfirmation,
  type StandardSetConfirmationState,
} from './project-acceptance';
import {
  readCriterionIndependence,
  type CriterionAuthorshipConflict,
  type CriterionIndependence,
  type CriterionIndependenceRemedy,
} from './project-criterion-independence';
import { readCriterionLanding, type CriterionLanding } from './project-criterion-landing';
import { readCriterionSatisfaction } from './project-criterion-satisfaction';

/**
 * `project.status = 'DONE'` as a PROJECTION of two committed facts, rather than a column somebody
 * writes.
 *
 * WHAT THIS REVERSES, AND WHOSE DECISION THAT IS
 * ----------------------------------------------
 * Migration 0229 says, in its own words, "The DONE gate is not replaced. The owner was offered a
 * narrower guard and chose the other option": after it, settling a project was an ordinary column
 * write any actor could make. That was not an oversight and this file must not be read as fixing
 * a bug. It is a RE-DELIBERATION. The account owner was asked again on 2026-09-08, with the 0229
 * decision quoted back to them, and answered that the derivation should be built.
 *
 * WHY THAT DOES NOT REINSTATE WHAT 0229 REMOVED
 * ---------------------------------------------
 * 0229 deleted a JUDGING MACHINE and kept the DECLARATION — "the machine goes, the declaration
 * stays". None of that machine comes back here, and nothing in this file is on the write path of
 * anything:
 *
 *   * No table. The four acceptance tables (`project_acceptance_run`, `_criterion`, `_conclusion`,
 *     `_audit`) and the `project_acceptance_verdict` enum stay dropped; the six `project` columns
 *     (`accepted_run_id`, `acceptance_epoch`, `legacy_accepted_at`, `acceptance_criteria` and its
 *     digest and format) stay dropped. This unit adds no migration at all.
 *   * No trigger. The four triggers 0229 removed from `project` — and with them 0150's
 *     alphabetical firing-order constraint, whose disappearance that migration records as its
 *     INTENT and not a side effect — stay removed. Nothing here runs inside the database.
 *   * No GATE. A gate refuses somebody's write. This refuses nobody: it RECOMPUTES the column
 *     from rows that are already committed and stores the answer. Everything that could write
 *     `status` before this unit can still write it, and the one rule that turns any of them away
 *     is r2's `refuseProjectStatusWrite`, which is about who is asking and predates this file.
 *
 * WHERE THE INPUTS COME FROM
 * --------------------------
 * Both are read from rows that already exist, with no clock anywhere in the derivation — the same
 * inputs read twice give the same answer, and a project does not become DONE by the passage of
 * time.
 *
 *   (a) EVERY stated criterion is `satisfied`, is `landing === 'LANDED'`, and COUNTS AT ALL. The
 *       first two come from the readers the project detail page already uses
 *       (`readCriterionSatisfaction`, `readCriterionLanding`) rather than from a second definition
 *       of either: a derivation that recomputed "satisfied" here could disagree with the value a
 *       person is shown, and then no answer on the screen would mean anything. `satisfied` alone
 *       is not enough and the landing lane's own header says why — settling happens in a task
 *       session's worktree and says nothing about the default branch.
 *
 *       The third is `project-criterion-independence.ts`, and it is the SEPARATION OF DUTIES: a
 *       criterion whose standing version was written by one of the very sessions producing its
 *       evidence is somebody's own exam, and does not count. That is an equality between two
 *       committed session ids, which is the whole reason it takes over from the `dispatch_origin`
 *       identity gate that used to stand for this rule — a gate whose own header records that
 *       NON_JUDGMENT "is expressly not evidence that a human held the authenticated credential",
 *       and which therefore could not decide the question it was standing in for. A criterion that
 *       does not count is WITHHELD and named, never filtered out: settling against the criteria
 *       that remain would settle this project against a shorter standard set than the one its
 *       owner confirmed, and would say so nowhere.
 *   (b) A confirmation naming THE VERSION OF THE CRITERIA THAT STANDS TODAY: r3's
 *       `project_standard_set_confirmation`, compared against `criteriaSemanticRevision` by
 *       `standardSetConfirmationStanding`, which is r3's comparison and not a copy of it. Editing
 *       an assertion or its verification method moves the digest, so the confirmation stops
 *       counting and this projection stops saying DONE — with no flag anybody has to clear. Of
 *       the STORED column as well as of a live read: the write that states the criteria
 *       (`ProjectsService.update`) re-projects on its own post-commit edge, so an edit does not
 *       leave the column asserting DONE until something unrelated happens along.
 *
 * (b) is the half a person supplies, and it is what keeps `SETTLE_PROJECT_DONE` honestly AUTOMATIC
 * in `coordinator-authority.ts`: what the owner writes is the CONFIRMATION, and DONE is the
 * projection of it onto work that has landed. "No principal writes it" becomes true of the server
 * rather than of an intention.
 */

/** Why the projection is withholding DONE. Empty exactly when it is not. */
export type DerivedDoneWithheld =
  /** A project that states no criteria states no goal, so there is nothing for work to meet.
   *  "Every one of zero criteria holds" is the same vacuous truth `NO_WORK_SERVES_IT` refuses one
   *  level down, and a project would otherwise settle itself the moment it was confirmed empty. */
  | 'NO_CRITERIA_STATED'
  /** Some criterion's serving work has not settled by its own declared completion criterion. */
  | 'CRITERION_UNSATISFIED'
  /** Some criterion has no merge receipt onto the default branch. `UNKNOWN` is absence of
   *  evidence, never evidence of absence — so this withholds DONE, and asserts nothing. */
  | 'CRITERION_UNLANDED'
  /** Some criterion's standing version was written by a session that is also producing the
   *  evidence counted for it, so that criterion does not count — and a project cannot settle
   *  against a standard set smaller than the one its owner confirmed. */
  | 'CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE'
  /** Nobody has confirmed this standard set, or the confirmation names a version that has since
   *  been edited. */
  | 'STANDARD_SET_UNCONFIRMED';

/** One criterion, as the three work-side lanes answer for it. */
export interface DerivedDoneCriterion {
  definitionId: string;
  satisfied: boolean;
  landing: CriterionLanding;
  /** Whether this criterion counts towards settlement at all. */
  independence: CriterionIndependence;
  /** The sessions on both sides of that equality, and the work they ran. Empty exactly when
   *  `independence` is `INDEPENDENT`. */
  conflicts: CriterionAuthorshipConflict[];
  /** What would make a criterion that does not count, count. Null exactly when it already does —
   *  which is what makes a withheld criterion something a card can render rather than something
   *  quietly missing from a total. */
  remedy: CriterionIndependenceRemedy | null;
}

/** The projection: the status these facts project, and — when it is not DONE — what is missing. */
export interface DerivedProjectDone {
  status: Extract<ProjectStatus, 'OPEN' | 'DONE'>;
  done: boolean;
  withheld: DerivedDoneWithheld[];
  criteria: DerivedDoneCriterion[];
  confirmation: StandardSetConfirmationState;
}

/**
 * The whole rule, over facts a caller has already read.
 *
 * A conjunction, and pure. Every clause that does not hold is reported rather than the first one,
 * because a reader asking why a finished-looking project is not DONE is asking about all of them.
 */
export function deriveProjectDone(
  criteria: readonly DerivedDoneCriterion[],
  confirmation: StandardSetConfirmationState,
): DerivedProjectDone {
  const withheld: DerivedDoneWithheld[] = [];
  if (criteria.length === 0) withheld.push('NO_CRITERIA_STATED');
  if (criteria.some((criterion) => !criterion.satisfied)) withheld.push('CRITERION_UNSATISFIED');
  if (criteria.some((criterion) => criterion.landing !== 'LANDED')) withheld.push('CRITERION_UNLANDED');
  // Withheld, and not filtered out: a criterion that does not count still IS one of the criteria
  // this project's owner confirmed, so dropping it from the conjunction would settle the project
  // against a shorter standard set than the one on record — and would say so nowhere.
  if (criteria.some((criterion) => criterion.independence !== 'INDEPENDENT')) {
    withheld.push('CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE');
  }
  if (confirmation !== 'CONFIRMED') withheld.push('STANDARD_SET_UNCONFIRMED');
  const done = withheld.length === 0;
  return {
    status: done ? ProjectStatus.DONE : ProjectStatus.OPEN,
    done,
    withheld,
    criteria: [...criteria],
    confirmation,
  };
}

/** The delegates this unit reads. Named rather than taking the whole client so a caller can see
 *  that a projection of a project's status touches four tables and writes one of them. */
type DerivationClient = Pick<
  PrismaService,
  'project'
  | 'projectAcceptanceCriterionDefinition'
  | 'projectCriteriaAuthorship'
  | 'projectStandardSetConfirmation'
>;

/**
 * Read both inputs and project the status, without writing anything.
 *
 * The three work-side lanes are issued in the same batch as the confirmation read, in the shape
 * `ProjectsService.get` already uses: one query per lane, never one per criterion.
 */
export async function readDerivedProjectDone(
  prisma: DerivationClient,
  ownerId: string,
  projectId: string,
): Promise<DerivedProjectDone> {
  const [definitions, satisfaction, landing, independence, confirmation] = await Promise.all([
    prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId, project: { ownerId } },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        ordinal: true,
        text: true,
        verificationMethod: true,
        completionCriterionOverrideReason: true,
        revision: true,
        contentHash: true,
      },
    }),
    readCriterionSatisfaction(prisma, ownerId, projectId),
    readCriterionLanding(prisma, ownerId, projectId),
    readCriterionIndependence(prisma, ownerId, projectId),
    latestConfirmation(prisma, projectId),
  ]);

  const landed = new Map(landing.map((row) => [row.definitionId, row.landing]));
  const independent = new Map(independence.map((row) => [row.definitionId, row]));
  const criteria = satisfaction.map((row) => ({
    definitionId: row.definitionId,
    satisfied: row.satisfied,
    // The same default `ProjectsService.get` serves: a criterion this lane has no receipt about
    // is UNKNOWN, which is exactly what it is for a criterion the lane never saw.
    landing: landed.get(row.definitionId) ?? ('UNKNOWN' satisfies CriterionLanding),
    // A criterion this lane never saw has no authorship row to collide with anything, which is
    // the same answer it gives for a criterion whose author is the owner or is unknown.
    independence: independent.get(row.definitionId)?.independence
      ?? ('INDEPENDENT' satisfies CriterionIndependence),
    conflicts: independent.get(row.definitionId)?.conflicts ?? [],
    remedy: independent.get(row.definitionId)?.remedy ?? null,
  }));

  return deriveProjectDone(
    criteria,
    standardSetConfirmationStanding(
      standardSetVersion(criteriaFromDefinitions(definitions)),
      confirmation,
    ).state,
  );
}

/**
 * Recompute the projection and store it — the only place this repository writes `project.status`
 * without being asked to.
 *
 * NOT A REQUEST, WHICH IS THE POINT
 * ---------------------------------
 * r2's `refuseProjectStatusWrite` turns away a REQUEST that carries `status` while an acting
 * session is on it. This write carries no `status` from anybody: there is no DTO, no session
 * header and no caller who named a value, so there is nothing for that rule to refuse and nothing
 * here that routes around it. The two stack in the intended order — a session still cannot ask for
 * DONE, and DONE still arrives, from the facts.
 *
 * That is also why this must never be implemented by calling `ProjectsService.update`: doing so
 * would put the projection behind a door that exists to refuse one, and the projection would be
 * refused on exactly the paths (a coordinator's own conversation) where its inputs are produced.
 *
 * BOTH DIRECTIONS, AND ONLY BETWEEN TWO VALUES
 * --------------------------------------------
 * A projection that could only ever set DONE would be a latch, and a latch is a decision rather
 * than a reading: reopening a criterion, or filing a new task against one, must take DONE away
 * again or the column would go on asserting something its inputs no longer support.
 *
 * CANCELLED is left alone in both directions. It says a person dropped this project, which is not
 * a claim about the work and not something the work can overturn — a projection that reopened a
 * cancelled project would be overruling the owner with a merge receipt.
 *
 * The compare-and-set is in the WHERE clause rather than in a read taken first: two concurrent
 * post-commit edges deriving the same answer write the row once, and the loser learns it wrote
 * nothing instead of racing to write the same value again.
 */
export async function storeDerivedProjectStatus(
  prisma: DerivationClient,
  ownerId: string,
  projectId: string,
): Promise<DerivedProjectDone> {
  const derived = await readDerivedProjectDone(prisma, ownerId, projectId);
  await prisma.project.updateMany({
    where: {
      id: projectId,
      ownerId,
      status: derived.done ? ProjectStatus.OPEN : ProjectStatus.DONE,
    },
    data: { status: derived.status },
  });
  return derived;
}

/** The newest confirmation on record, current or not — r3's read, in r3's order: `confirmedAt`
 *  then `id`, which is uuid(7) and so breaks a same-millisecond tie in the order rows were
 *  written. Deciding whether it still counts is `standardSetConfirmationStanding`'s job. */
async function latestConfirmation(
  prisma: Pick<PrismaService, 'projectStandardSetConfirmation'>,
  projectId: string,
): Promise<RecordedStandardSetConfirmation | null> {
  const row = await prisma.projectStandardSetConfirmation.findFirst({
    where: { projectId },
    orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
    select: {
      criteriaDigest: true,
      criteriaMaterial: true,
      confirmedAt: true,
      confirmedById: true,
    },
  });
  return row === null ? null : {
    criteriaDigest: row.criteriaDigest,
    criteriaMaterial: row.criteriaMaterial as unknown as RecordedStandardSetConfirmation['criteriaMaterial'],
    confirmedAt: row.confirmedAt,
    confirmedById: row.confirmedById,
  };
}
