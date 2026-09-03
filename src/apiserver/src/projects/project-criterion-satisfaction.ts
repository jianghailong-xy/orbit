import type { PrismaService } from '../prisma/prisma.service';
import type { TaskCompletionCriterionValue } from '../tasks/task-completion-criterion';
import {
  evaluateTaskCompletion,
  taskCompletionRequiredAction,
} from '../tasks/task-completion-criterion';
import {
  criterionDeclarations,
  type CriterionServingTask,
} from './project-criterion-declaration-staleness';
import {
  verificationIsLive,
  type AggregationTaskStatus,
  type TaskVerdictValue,
} from './task-aggregation';

/**
 * T3: "is criterion C satisfied?", answered entirely from the WORK side.
 *
 * This is the question the reversed edge exists to answer, and the whole of its point is that the
 * criterion does not have to point at anything to answer it. The minimum information is which work
 * says it serves C and whether that work has settled — both of which live on `task`. So this read
 * touches none of the four wiring columns on the criterion (`evidence_task_id`,
 * `completion_criterion`, `acceptance_command`, `acceptance_expected_exit_code`), which is what
 * lets T4 drop them without this answer changing. `project-criterion-satisfaction.pg.spec.ts`
 * proves that by dropping all four inside a rolled-back transaction and re-deriving.
 *
 * A READ, AND NOTHING ELSE
 * ------------------------
 * Nothing here gates a write, and in particular nothing here is consulted by `project.status =
 * 'DONE'`. 0229 said "The DONE gate is not replaced. The owner was offered a narrower guard and
 * chose the other option", and 0223 said the protection it removed was removed, not relocated, so
 * "nothing should be added later that quietly reinstates an equivalent protection under another
 * name". Whether an unsatisfied criterion should block anything is the owner's decision and is not
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
 *  - `SERVING_WORK_UNSETTLED` — some task that serves it has not settled BY ITS OWN DECLARED
 *    CRITERION. A conjunction, not a disjunction: one finished task among five does not make the
 *    stated condition true, and each of the five is judged by the criterion it declared rather
 *    than by a blanket `status = 'DONE'`.
 *  - `DECLARATION_STALE` — some task declared a revision that is not the one the criterion carries
 *    today. T2 owns that comparison; this clause is its fold, not a second copy of it.
 */
export type CriterionUnmetClause =
  | 'NO_WORK_SERVES_IT'
  | 'SERVING_WORK_UNSETTLED'
  | 'DECLARATION_STALE';

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
  /** The independent checks pointed at this task, whose PASS settles it as a subject. */
  verifiedBy: ReadonlyArray<{
    status: string;
    verdict: TaskVerdictValue | null;
    terminalReason: string | null;
    supersededByTaskId: string | null;
  }>;
}

/** The rows the fold needs, kept structural so it is testable without Prisma. */
export interface CriterionWithSettlementFacts {
  id: string;
  ordinal: number;
  revision: number;
  servingTasks: ReadonlyArray<ServingTaskFacts>;
}

/**
 * Whether one serving task has settled BY ITS OWN DECLARED CRITERION.
 *
 * The switch is the substance of clause 2. `status = 'DONE'` would be one sentence shorter and
 * would say something else — that a projection agreed — where this asks each task the question it
 * declared it would be asked. The three arms are peers and each names the fact it reads:
 *
 *  - EXECUTABLE: `status = 'DONE'` IS its stored settlement fact, and this arm is not a shortcut
 *    to the other two. 0230 restored the exit-code comparison in `runnerApi.turnComplete`, where
 *    it happens under the task's row lock and is then dropped — the owner's instruction was
 *    "根据 exit code 来简单判断，不需要实际记录数据" — so no exit code is stored anywhere for this
 *    read to compare. The compare-and-set that write performs is the only thing that puts an
 *    EXECUTABLE task into DONE, and 0193's fence stands behind it, so DONE here is the trace of a
 *    comparison that happened and agreed.
 *  - VERIFICATION: a live PASS from an independent check, or, for a carrier, its own verdict.
 *    Both are rows this read can go and look at, so it hands them to the shared evaluator.
 *  - EVIDENCE_JUDGMENT: never settled. Its implementation was removed on 2026-09-02 and has not
 *    been rebuilt, so `evaluateTaskCompletion` answers UNSATISFIED for every such task, whatever
 *    its status. A criterion served by one is therefore held up by it, and says so — that is a
 *    true and visible fact about this system rather than a defect in this read.
 */
export function servingTaskSettled(task: ServingTaskFacts): boolean {
  switch (task.completionCriterion) {
    case 'EXECUTABLE':
      return task.status === 'DONE';
    case 'VERIFICATION':
      return evaluateTaskCompletion({
        completionCriterion: 'VERIFICATION',
        verifiesTaskId: task.verifiesTaskId,
        ownVerdict: task.verdict,
        verificationVerdict: livePassVerdict(task.verifiedBy),
      }).satisfied;
    case 'EVIDENCE_JUDGMENT':
      return evaluateTaskCompletion({ completionCriterion: 'EVIDENCE_JUDGMENT' }).satisfied;
  }
}

/**
 * The one PASS that counts, with the liveness rule the aggregation and 0193's fence already use:
 * a cancelled, retired or superseded check is not the check that settles anything.
 */
function livePassVerdict(
  verifiedBy: ServingTaskFacts['verifiedBy'],
): TaskVerdictValue | null {
  const passed = verifiedBy.some((check) => check.verdict === 'PASS' && verificationIsLive({
    status: check.status as AggregationTaskStatus,
    retired: check.terminalReason != null || check.supersededByTaskId != null,
  }));
  return passed ? 'PASS' : null;
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
    requiredAction: taskCompletionRequiredAction(task.completionCriterion, {
      verifiesTaskId: task.verifiesTaskId,
    }).requiredAction,
    criterionRevision: task.criterionRevision,
    criterionRevisionStale: declaration.criterionRevisionStale,
  };
}

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
          verifiedBy: {
            select: {
              status: true,
              verdict: true,
              terminalReason: true,
              supersededByTaskId: true,
            },
          },
        },
      },
    },
  });
  return criterionSatisfaction(definitions);
}
