import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  CoordinatorDeliveryService,
  type CoordinatorDeliveryOutcome,
} from './coordinator-delivery.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorJudgmentService,
  type JudgmentOutcome,
} from './coordinator-judgment.service';
import { type SettledCriterionReport, projectTasksSettledFact } from './coordinator-wake';
import type { WakeAuthorizer } from './coordinator-wake.service';
import { criterionKeyOf } from './project-acceptance';
import { criterionLanding } from './project-criterion-landing';
import { criterionCoverage } from './wake-disposition';

/**
 * The project's automation switch is off at the authorization read which follows a won claim.
 *
 * Kept as the same spelling T2's ledger examples already use: this is a refusal of automation,
 * not a statement that the committed task fact was false. The refused wake releases its key.
 */
export const SETTLED_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/** The project disappeared after its task rows were read and before the won wake was authorized. */
export const SETTLED_WAKE_PROJECT_GONE = 'PROJECT_GONE';

export interface SettledProjectDelivery {
  projectId: string;
  outcome:
    | JudgmentOutcome['outcome']
    | CoordinatorDeliveryOutcome['outcome']
    | 'NOT_SETTLED';
}

/**
 * Unit T7: turn committed task rows into `PROJECT_TASKS_SETTLED` wakes.
 *
 * This deliberately lives on the post-commit side of a task write. Reaching a coordinator is heavy
 * — it may queue a runner — and cannot be part of the transaction which changes the task. More
 * importantly, the fact's version must be derived from the rows which ACTUALLY committed, including
 * aggregate parents that the originating write may have settled. The producer therefore receives
 * project ids, re-reads their complete task sets, derives T2's closed fact, and spends it.
 *
 * There is no timer and no process-local exclusion here. Concurrent last-task writes can both
 * derive the same fact; the wake ledger's partial unique index decides which one wins. Re-delivery
 * is consequently both safe and useful.
 *
 * §1 — TWO TERMINALS, AND WHAT DECIDES BETWEEN THEM
 * =================================================
 * "Every task reached a terminal status" is not "the project is done", and on its own it is not
 * even evidence in that direction: a criterion nobody filed work against, and a criterion whose
 * finished work is on a branch, both survive it untouched. This repository's own project reached
 * every-task-settled with criteria reporting `landing: UNKNOWN`.
 *
 * So the roster is re-read, after the commit, from the criteria the project STATES, and the two
 * dimensions are the ones their own modules own — `criterionCoverage` for whether the serving work
 * finished, `criterionLanding` for whether a merge receipt puts it on the default branch. Neither
 * is recomputed here; a second reading of "landed" is a second answer a person could be shown.
 *
 *   * Every stated criterion satisfied AND landed → the confirmation card, DELIVERED to the
 *     conversation this project is already coordinated from. What is being asked is the one act
 *     reserved to the account owner (`CONFIRM_ACCEPTANCE_CRITERIA`): do these conditions, together,
 *     express the goal. A conversation opened for that question would be a conversation with
 *     nobody in it, and the project already names the one a person is in.
 *   * Anything else → the judgment session this event has always opened, on the protocol that
 *     tells it to go and look at `main`. That branch is untouched, because it is the branch the
 *     card is NOT for: a project whose work is not all on the branch has something to do before
 *     anybody is asked to confirm anything.
 *
 * §2 — WHY THE ROSTER IS READ BEFORE THE CLAIM
 * ============================================
 * `coordinator-wake.ts` §1 forbids an authorization decision before the key is claimed, because a
 * key computed after a permission branch makes the winner of a race depend on permission. This
 * read is not that, by the argument `WakeDispositionService.openIfDecisive` makes about its own:
 * it cannot change the key — the key is a total function of the fact, and the roster travels in
 * `detail`, which is outside it — and it cannot refuse the wake. Both branches end in a status
 * inside 0174's partial unique index, so whichever one a delivery takes it claims the same key and
 * loses the same races.
 *
 * That the roster is outside the key is also what makes the pair honest over time: a criterion
 * whose receipt arrives later is the SAME settled task set, so the card is not a second fact about
 * it. What produces the card in that case is the next settlement — which is why the branch that
 * did not send one still leaves the fact, and its roster, in the ledger for a reader.
 */
@Injectable()
export class ProjectTasksSettledProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
    private readonly convergence: CoordinatorConvergenceService,
    private readonly deliveries: CoordinatorDeliveryService,
  ) {}

  async afterCommit(
    projectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<SettledProjectDelivery[]> {
    const ids = [...new Set(projectIds.filter((id): id is string => !!id))].sort();
    const deliveries: SettledProjectDelivery[] = [];

    for (const projectId of ids) {
      const tasks = await this.prisma.task.findMany({
        where: { projectId },
        select: { id: true, status: true },
      });
      const criteria = await this.statedCriteria(projectId);
      const fact = projectTasksSettledFact(
        projectId,
        tasks.map((task) => ({ taskId: task.id, status: task.status })),
        criteria,
      );
      if (!fact) {
        deliveries.push({ projectId, outcome: 'NOT_SETTLED' });
        continue;
      }

      const authorize: WakeAuthorizer = async (claimedFact, claim) => {
        // T2's order is claim first, authorize second. Do not hoist this read above the spend:
        // doing so would make permission participate in who wins the idempotency key.
        const project = await this.prisma.project.findUnique({
          where: { id: projectId },
          select: { coordinatorEnabled: true },
        });
        if (!project) {
          return { allowed: false as const, refusalCode: SETTLED_WAKE_PROJECT_GONE };
        }
        if (!project.coordinatorEnabled) {
          return { allowed: false as const, refusalCode: SETTLED_WAKE_COORDINATOR_DISABLED };
        }
        // T4 is deliberately last: this decision spends a convergence pass, so no cheaper refusal
        // may run after it and charge a wake whose terminal will never be reached.
        return this.convergence.authorizeWake(claimedFact, claim);
      };

      const outcome = confirmable(criteria)
        ? await this.deliveries.deliver(fact, authorize)
        : await this.judgments.wake(fact, authorize);
      deliveries.push({ projectId, outcome: outcome.outcome });
    }

    return deliveries;
  }

  /**
   * Every criterion this project states, with the two dimensions the card reports.
   *
   * One query, and the fold over its rows is `criterionLanding`'s — the same nested read the
   * person looking at this project makes for the same question, rather than a WHERE clause here
   * that would decide for itself which receipts count.
   */
  private async statedCriteria(projectId: string): Promise<SettledCriterionReport[]> {
    const definitions = await this.prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId },
      select: {
        id: true,
        text: true,
        servingTasks: {
          select: {
            id: true,
            title: true,
            status: true,
            mergeReceipts: { select: { result: true, targetBranch: true } },
          },
        },
      },
      orderBy: { ordinal: 'asc' },
    });
    const landed = new Map(
      criterionLanding(definitions).map((answer) => [answer.definitionId, answer.landing]),
    );
    return definitions.map((definition) => ({
      key: criterionKeyOf(definition.id),
      text: definition.text,
      satisfied: criterionCoverage(
        definition.servingTasks.map((task) => ({ taskId: task.id, status: task.status })),
      ) === 'BACKED',
      landing: landed.get(definition.id) ?? 'UNKNOWN',
      serving: definition.servingTasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
      })),
    }));
  }
}

/**
 * Whether this settled project may be asked to confirm its own ruler.
 *
 * A project that states NO criteria is not confirmable, and the emptiness is the reason rather
 * than an oversight: `[].every` is vacuously true, and "these zero conditions express your goal"
 * is not a question anybody can answer. It goes to the judgment branch like any other project
 * whose stated conditions are not all met and landed.
 */
function confirmable(criteria: readonly SettledCriterionReport[]): boolean {
  return criteria.length > 0
    && criteria.every((criterion) => criterion.satisfied && criterion.landing === 'LANDED');
}
