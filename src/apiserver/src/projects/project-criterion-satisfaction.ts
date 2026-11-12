import type { PrismaService } from '../prisma/prisma.service';
import type { TaskCompletionCriterionValue } from '../tasks/task-completion-criterion';
import {
  evaluateTaskCompletion,
  taskCompletionRequiredAction,
} from '../tasks/task-completion-criterion';
import type { EvidenceDecisionValue } from '../tasks/task-evidence-decision';
import { newestLiveCheck } from '../tasks/verification-dependency';
import {
  criterionDeclarations,
  type CriterionServingTask,
} from './project-criterion-declaration-staleness';
import type { TaskVerdictValue } from './task-aggregation';
import {
  CRITERION_CONFIRMATION_SELECT,
  criterionConfirmationStanding,
  type CriterionConfirmationFacts,
  type CriterionConfirmationStanding,
  type CriterionSatisfiedByValue,
} from './project-criterion-confirmation';

/**
 * T3: "is criterion C satisfied?", answered entirely from the WORK side.
 *
 * This is the question the reversed edge exists to answer, and the whole of its point is that the
 * criterion does not have to point at anything to answer it. The minimum information is which work
 * says it serves C and whether that work has settled — both of which live on `task`. This read
 * named none of the four wiring columns the criterion used to carry, which is what let migration
 * 0233 drop them without this answer changing; it names nothing on the criterion beyond its
 * identity even now. `project-criterion-satisfaction.pg.spec.ts` proves that by dropping every
 * non-identity column inside a rolled-back transaction and re-deriving.
 *
 * A READ, AND NOTHING ELSE
 * ------------------------
 * Nothing here gates a write. Since 2026-09-08 this answer IS consulted by `project.status =
 * 'DONE'` — `project-done-derived.ts` folds it into a projection of that column — and the sentence
 * that used to stand here said it was not. That is a change of fact and not a loosening of the
 * rule below. 0229 said "The DONE gate is not replaced. The owner was offered a narrower guard and
 * chose the other option", and 0223 said the protection it removed was removed, not relocated, so
 * "nothing should be added later that quietly reinstates an equivalent protection under another
 * name". Neither was routed around: the owner was asked again on 2026-09-08 with 0229's own
 * sentence quoted back to them and answered that the projection should be built, and a projection
 * refuses nobody — everything that could set `status` before can still set it. Whether an
 * unsatisfied criterion should BLOCK anything is still the owner's decision and is still not
 * smuggled in here. What this buys instead is visibility: a coordinator or an owner can see WHICH
 * clause is missing and WHICH task is holding it up, which is why every unmet clause carries the
 * work that holds it rather than only a boolean.
 */

/**
 * The three clauses, each of which had to earn its place.
 *
 *  - `NO_WORK_SERVES_IT` — nobody has filed work against this criterion. "Every one of zero
 *    serving tasks has settled" is true and means nothing, which is the same vacuous truth the
 *    child/verification aggregation already refuses in `task-aggregation`: a criterion nobody has
 *    done anything about is not a criterion that has been met.
 *  - `SERVING_WORK_UNSETTLED` — some task that serves it has not settled: it is not DONE, or not by
 *    its own declared criterion, or a check of it has not passed. A conjunction, not a disjunction:
 *    one finished task among five does not make the stated condition true, and each of the five is
 *    judged by the criterion it declared as well as by `status = 'DONE'`.
 *  - `DECLARATION_STALE` — some task declared a revision that is not the one the criterion carries
 *    today. T2 owns that comparison; this clause is its fold, not a second copy of it.
 */
export type CriterionUnmetClause =
  | 'NO_WORK_SERVES_IT'
  | 'SERVING_WORK_UNSETTLED'
  | 'DECLARATION_STALE'
  /** A CONFIRMATION criterion (migration 0545) with no standing confirmation of its current
   *  revision: never confirmed, confirmed on an earlier revision, withdrawn, or its newest Agent
   *  check failed. `confirmation.state` says which. The three clauses above are TASKS clauses and
   *  a CONFIRMATION criterion trips none of them. */
  | 'NOT_CONFIRMED';

/** One piece of work standing between a criterion and being satisfied, and why it is. */
export interface CriterionBlockingTask {
  taskId: string;
  title: string;
  status: string;
  /** The criterion this task itself declared — the one it has to settle by. */
  completionCriterion: TaskCompletionCriterionValue;
  /** What would settle it, quoted from the table every completion refusal already quotes. */
  requiredAction: string;
  /** The revision this task declared it was serving. */
  criterionRevision: number | null;
  criterionRevisionStale: boolean;
}

/** One clause that does not hold, and the work that holds it up. */
export interface CriterionUnmetReason {
  clause: CriterionUnmetClause;
  /** Empty only for `NO_WORK_SERVES_IT`, whose whole content is that there is nobody to name. */
  heldUpBy: CriterionBlockingTask[];
}

/** One stated criterion, and whether the work filed under it has met it. */
export interface CriterionSatisfaction {
  definitionId: string;
  ordinal: number;
  /** What the criterion says TODAY: the revision every declaration below is measured against. */
  revision: number;
  satisfied: boolean;
  /** Empty exactly when `satisfied`. Every clause that does not hold, in clause order. */
  unmet: CriterionUnmetReason[];
  /** How this criterion is met. */
  satisfiedBy: CriterionSatisfiedByValue;
  /** Where its confirmation stands — null for a TASKS criterion, whose work answers for it. */
  confirmation: CriterionConfirmationStanding | null;
}

/** One check pointed at a task: what picks the newest live one, and what it concluded. */
export interface ServingCheckFacts {
  id: string;
  createdAt: Date;
  status: string;
  verdict: TaskVerdictValue | null;
  terminalReason: string | null;
  supersededByTaskId: string | null;
}

/** The settlement facts of one serving task, on top of the declaration facts T2 already reads. */
export interface ServingTaskFacts {
  id: string;
  title: string;
  status: string;
  criterionDefinitionId: string | null;
  criterionRevision: number | null;
  /** How THIS task says its own work is proved complete. */
  completionCriterion: TaskCompletionCriterionValue;
  /** Non-null identifies this task as a verification carrier rather than an ordinary subject. */
  verifiesTaskId: string | null;
  /** A carrier's own conclusion. */
  verdict: TaskVerdictValue | null;
  /** The independent checks pointed at this task, whose newest live one answers for it. */
  verifiedBy: ReadonlyArray<ServingCheckFacts>;
  /** What a carrier checks: whether that work is DONE now, and every check of it. Null otherwise. */
  verifies: { status: string; verifiedBy: ReadonlyArray<ServingCheckFacts> } | null;
  /**
   * The head of this task's completion-evidence ledger — newest first, and only ever one row —
   * carrying the decision made about it. A list because that is the shape the query answers with;
   * what the criterion turns on is the first element and whether anybody confirmed it.
   */
  completionEvidence: ReadonlyArray<{
    revision: bigint;
    decisions: ReadonlyArray<{ decision: EvidenceDecisionValue }>;
  }>;
}

/** The rows the fold needs, kept structural so it is testable without Prisma. */
export interface CriterionWithSettlementFacts {
  id: string;
  ordinal: number;
  revision: number;
  servingTasks: ReadonlyArray<ServingTaskFacts>;
  /** Absent reads as TASKS: every row before migration 0545, and every fixture that predates it. */
  satisfiedBy?: CriterionSatisfiedByValue;
  /** Its confirmation rows; read only for a CONFIRMATION criterion. */
  confirmations?: ReadonlyArray<CriterionConfirmationFacts>;
}

/**
 * Whether one serving task has settled.
 *
 * THREE QUESTIONS, ASKED IN THIS ORDER
 * ------------------------------------
 *  1. Is it DONE? Whatever it declared, a task that is not DONE has not settled. Two of the arms
 *     below stand on facts that outlive a reopen, a CONFIRM and a PASS, and a reopened task's
 *     CONFIRM answers for the work before the reopen. On 2026-11-03 that stored a project DONE with
 *     one of its tasks being reworked (`project-done-derived.pg.spec.ts`). CANCELLED and FAILED are
 *     not DONE either: a project resting on work somebody dropped has not been proven, and a task
 *     that no longer belongs under the criterion moves off it.
 *  2. Is it a check, or does a check answer for it? A carrier settles only on a PASS, and only while
 *     the work it passed is still DONE. Any verdict concludes a carrier, and that stays
 *     `evaluateTaskCompletion`'s answer, because it is what makes the carrier itself DONE and what
 *     its dependents read. It is not this question's answer: a FAIL is a finished check and
 *     unfinished work. Work a check is pointed at is held by that check whether or not the check
 *     serves the criterion, which is also how a dependency on that work is held.
 *  3. Did it settle by its own declared criterion? The switch below, each arm reading its own fact.
 *
 * WHICH CHECK ANSWERS, WHEN THERE ARE SEVERAL
 * -------------------------------------------
 * The subject's newest live check (`newestLiveCheck`), for the subject and for every check of it.
 * It is §13.3's rule, and the dependency gate and the aggregation already decide on that row, so a
 * criterion cannot disagree with them about which check counts:
 *
 *  - An older FAIL under a newer PASS is met. That is fix-and-re-run. Counting each check's own
 *    verdict instead would wedge it, because a concluded check cannot name a successor: its verdict
 *    has to be revoked before it can be cancelled, and a cancelled row is not DONE. On production on
 *    2026-11-03, 13 subjects had two or more checks and 8 of them an older FAIL under a newer PASS.
 *    None of those yet had both checks serving one criterion, so this rule moved nothing there.
 *  - An older PASS under a newer FAIL, or under a check still running, is not met. A newer check
 *    re-opens the question, which is why "any PASS" is not the rule either.
 *  - A cancelled or retired check answers nothing: the one before it answers again.
 *
 * A subject with no live check at all has nothing answering for it, so a VERIFICATION subject stays
 * unsettled and any other is judged by its own criterion alone.
 *
 * THE ARMS OF QUESTION 3
 * ----------------------
 *  - EXECUTABLE: `status = 'DONE'` IS its stored settlement fact, so question 1 was all of it. 0230
 *    restored the exit-code comparison in `runnerApi.turnComplete`, where it happens under the
 *    task's row lock and is then dropped — the owner's instruction was
 *    "根据 exit code 来简单判断，不需要实际记录数据" — so no exit code is stored anywhere for this
 *    read to compare. The compare-and-set that write performs is the only thing that puts an
 *    EXECUTABLE task into DONE, and 0193's fence stands behind it, so DONE here is the trace of a
 *    comparison that happened and agreed.
 *  - OWNER_CONFIRMED: the same, for EXECUTABLE's reason. The account owner's CONFIRM is the only
 *    thing that writes it (`TaskOwnerConfirmationService`), and 0267's lane in the DONE fence admits
 *    the write only while the owner's newest decision about the task is that CONFIRM, so DONE here
 *    is the trace of the owner's own word.
 *  - VERIFICATION: question 2 has already read the newest live check, and only a PASS settles.
 *  - EVIDENCE_JUDGMENT: a CONFIRM decision standing on the newest revision of this task's
 *    completion evidence. DONE alone cannot stand in for it, because an aggregate policy can write
 *    DONE with nobody having judged anything. Two rows this read can go and look at, handed to the
 *    shared evaluator rather than compared here. Until 2026-09-04 this arm could not be satisfied
 *    at all, so a criterion any such task served was held up by it forever, whatever the work had
 *    done — which is why the arm is written as facts read rather than as a constant.
 */
export function servingTaskSettled(task: ServingTaskFacts): boolean {
  if (task.status !== 'DONE') return false;
  if (task.verifiesTaskId != null) {
    return task.verifies?.status === 'DONE' && checkAnswer(task.verifies.verifiedBy) === 'PASSED';
  }
  const checks = checkAnswer(task.verifiedBy);
  if (checks === 'NOT_PASSED') return false;
  switch (task.completionCriterion) {
    case 'EXECUTABLE':
    case 'OWNER_CONFIRMED':
      return true;
    case 'VERIFICATION':
      return checks === 'PASSED';
    case 'EVIDENCE_JUDGMENT': {
      const [latest] = task.completionEvidence;
      return evaluateTaskCompletion({
        completionCriterion: 'EVIDENCE_JUDGMENT',
        latestEvidenceRevision: latest?.revision ?? null,
        confirmedEvidenceRevision: latest?.decisions.some(({ decision }) => decision === 'CONFIRM')
          ? latest.revision
          : null,
      }).satisfied;
    }
  }
}

/**
 * What a subject's checks say: its newest live check, with the liveness rule the epoch and 0193's
 * fence already use, asked of the evaluator that says what settles a subject. `NO_LIVE_CHECK` is
 * not `NOT_PASSED`: a subject whose checks were all cancelled or replaced has no check holding it.
 */
function checkAnswer(
  checks: ReadonlyArray<ServingCheckFacts>,
): 'PASSED' | 'NOT_PASSED' | 'NO_LIVE_CHECK' {
  const newest = newestLiveCheck(checks.map((check) => ({
    ...check,
    retired: check.terminalReason != null || check.supersededByTaskId != null,
  })));
  if (newest === null) return 'NO_LIVE_CHECK';
  return evaluateTaskCompletion({
    completionCriterion: 'VERIFICATION',
    verificationVerdict: newest.verdict,
  }).satisfied ? 'PASSED' : 'NOT_PASSED';
}

/**
 * What would settle one task, as the completion table says it: by its role, except that work
 * which has done its part and a check that has already concluded are both waiting on the same
 * thing, a pass. The table's own line for a concluded carrier would read "needs its verdict
 * recorded" about a row whose verdict is what is holding the criterion up.
 */
function settlingAction(task: ServingTaskFacts): string {
  const waitingOnAPass = task.verifiesTaskId != null
    ? task.verdict != null
    : task.status === 'DONE' && checkAnswer(task.verifiedBy) === 'NOT_PASSED';
  return taskCompletionRequiredAction(
    waitingOnAPass ? 'VERIFICATION' : task.completionCriterion,
    { verifiesTaskId: waitingOnAPass ? null : task.verifiesTaskId },
  ).requiredAction;
}

/**
 * The derivation: three clauses over one criterion's serving work, and the reason for each one
 * that does not hold.
 *
 * Every unmet clause is reported, not just the first, and one task can appear under more than one
 * of them. Work that has not settled AND was declared against wording that has since moved has two
 * things wrong with it, and the reader this exists for — a coordinator or an owner looking at what
 * is still missing — is worse off being shown one of them and then, after fixing it, the next.
 *
 * `criterionDeclarations` is T2's fold and owns the staleness comparison; clause 3 reads its mark
 * rather than subtracting the two revisions a second time. Its output is one row per definition
 * and one row per serving task, in the same order as the input, which is why the two can be walked
 * by position.
 */
export function criterionSatisfaction(
  definitions: ReadonlyArray<CriterionWithSettlementFacts>,
): CriterionSatisfaction[] {
  const declared = criterionDeclarations(definitions);
  return definitions.map((definition, index) => {
    // A CONFIRMATION criterion is met by its confirmation alone: the work filed under it is not
    // asked, so none of the three TASKS clauses below — NO_WORK_SERVES_IT included — applies to it.
    if (definition.satisfiedBy === 'CONFIRMATION') {
      const confirmation = criterionConfirmationStanding(
        definition.revision, definition.confirmations ?? [],
      );
      const met = confirmation.state === 'CONFIRMED';
      return {
        definitionId: definition.id,
        ordinal: definition.ordinal,
        revision: definition.revision,
        satisfied: met,
        unmet: met ? [] : [{ clause: 'NOT_CONFIRMED', heldUpBy: [] }],
        satisfiedBy: 'CONFIRMATION',
        confirmation,
      };
    }
    const unsettled: CriterionBlockingTask[] = [];
    const stale: CriterionBlockingTask[] = [];
    for (const [position, task] of definition.servingTasks.entries()) {
      const declaration = declared[index].servingTasks[position];
      // Both clauses are asked of every task, so one piece of work that is neither settled nor
      // current is named under both — the two answers are about different things and a reader
      // who fixed only the one they were shown would be back here.
      if (!servingTaskSettled(task)) unsettled.push(blockingTask(task, declaration));
      if (declaration.criterionRevisionStale) stale.push(blockingTask(task, declaration));
    }
    const unmet: CriterionUnmetReason[] = [];
    if (definition.servingTasks.length === 0) {
      unmet.push({ clause: 'NO_WORK_SERVES_IT', heldUpBy: [] });
    }
    if (unsettled.length > 0) {
      unmet.push({ clause: 'SERVING_WORK_UNSETTLED', heldUpBy: unsettled });
    }
    if (stale.length > 0) {
      unmet.push({ clause: 'DECLARATION_STALE', heldUpBy: stale });
    }
    return {
      definitionId: definition.id,
      ordinal: definition.ordinal,
      revision: definition.revision,
      // The conjunction, stated once. `satisfied` is not a fourth fact that could disagree with
      // the list above it: it IS the list being empty.
      satisfied: unmet.length === 0,
      unmet,
      satisfiedBy: 'TASKS',
      confirmation: null,
    };
  });
}

/** What holds a criterion up, said about one task. */
function blockingTask(
  task: ServingTaskFacts,
  declaration: CriterionServingTask,
): CriterionBlockingTask {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    completionCriterion: task.completionCriterion,
    requiredAction: settlingAction(task),
    criterionRevision: task.criterionRevision,
    criterionRevisionStale: declaration.criterionRevisionStale,
  };
}

/** One check, as the fold reads it: spelled once, for the checks of a task and of its subject. */
const SERVING_CHECK_SELECT = {
  id: true,
  createdAt: true,
  status: true,
  verdict: true,
  terminalReason: true,
  supersededByTaskId: true,
} as const;

/**
 * Every criterion this project states, in the order it states them, and whether the work filed
 * under each has met it.
 *
 * One query, and every column it names is either the criterion's own identity or a fact about a
 * task. A criterion nobody serves comes back with an empty `servingTasks` rather than not coming
 * back, because clause 1 has to be able to say something about it.
 */
export async function readCriterionSatisfaction(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition'>,
  ownerId: string,
  projectId: string,
): Promise<CriterionSatisfaction[]> {
  const definitions = await prisma.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId, project: { ownerId } },
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      ordinal: true,
      revision: true,
      satisfiedBy: true,
      confirmations: CRITERION_CONFIRMATION_SELECT,
      servingTasks: {
        where: { ownerId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          title: true,
          status: true,
          criterionDefinitionId: true,
          criterionRevision: true,
          completionCriterion: true,
          verifiesTaskId: true,
          verdict: true,
          verifiedBy: { select: SERVING_CHECK_SELECT },
          verifies: { select: { status: true, verifiedBy: { select: SERVING_CHECK_SELECT } } },
          // Only the newest revision: an older one is a claim a later submission replaced, and the
          // criterion is about the claim standing now.
          completionEvidence: {
            orderBy: { revision: 'desc' },
            take: 1,
            select: { revision: true, decisions: { select: { decision: true } } },
          },
        },
      },
    },
  });
  return criterionSatisfaction(definitions);
}
