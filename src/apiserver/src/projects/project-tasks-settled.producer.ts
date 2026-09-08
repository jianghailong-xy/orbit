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
import {
  type SettledCriterionReport,
  projectAcceptanceLandedFact,
  projectTasksSettledFact,
} from './coordinator-wake';
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
 * Unit T7: turn committed task rows into the two facts a finished project can be in — a settled
 * task set (`PROJECT_TASKS_SETTLED`), or that AND every stated criterion on the default branch
 * (`PROJECT_ACCEPTANCE_LANDED`). §1 is what decides between them and §3 is why they are two.
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
 *   * Every stated criterion satisfied AND landed → `PROJECT_ACCEPTANCE_LANDED`, the confirmation
 *     card, DELIVERED to the conversation this project is already coordinated from. What is being
 *     asked is the one act reserved to the account owner (`CONFIRM_ACCEPTANCE_CRITERIA`): do these
 *     conditions, together, express the goal. A conversation opened for that question would be a
 *     conversation with nobody in it, and the project already names the one a person is in.
 *   * Anything else → `PROJECT_TASKS_SETTLED`, and the judgment session that event has always
 *     opened, on the protocol that tells it to go and look at `main`. That branch is untouched,
 *     because it is the branch the card is NOT for: a project whose work is not all on the branch
 *     has something to do before anybody is asked to confirm anything.
 *
 * The two are two EVENTS rather than two terminals of one, and §3 is why. Both are derived from
 * the same two reads and at most one of them exists at a time, so no project is both carded and
 * judged for one pass.
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
 * §3 — WHY THE CARD IS ITS OWN FACT, AND WHAT THE ONE-COMMIT VERSION COST
 * ======================================================================
 * For one commit the card was a BRANCH of `PROJECT_TASKS_SETTLED`: one fact, two terminals, the
 * roster deciding between them. §2's argument above is what made that look safe — the roster is
 * outside the key, so a criterion whose receipt arrives later is the same settled task set and the
 * card is not a second fact about it.
 *
 * Every clause of that is true and the conclusion did not follow. If the card is not a second fact
 * about the settled task set, then when the receipt arrives there is NO fact left to derive: the
 * task set is unchanged, so the key is the one the judgment branch already spent, and re-deriving
 * answers ALREADY_AWAKE. Not "the card is late" — the card is never sent, until some unrelated
 * task write happens to move the digest. And the order this repository actually runs in is exactly
 * that order: the last task settles while the work is still on a branch, and the receipt is
 * recorded afterwards by `session_merge`, by a runner or by an agent, none of which calls this
 * door at all. `project-settled-card.pg.spec.ts` had to file a chore task and cancel it to get a
 * second derivation, and said so in a comment; that comment was the defect, written down.
 *
 * So the card is `PROJECT_ACCEPTANCE_LANDED` — its own event, keyed on the settlement AND the
 * roster's landings together. It admits no partial state, so it spends no key while the answer is
 * incomplete, and the moment the last receipt lands it derives a key nothing has ever claimed.
 * `coordinator-wake.ts` carries the full argument, including why this is not the receipts-folded-
 * into-`settlementVersion` shape that `criterionUnlandedFact` refuses.
 *
 * What remains true from §2 is the reason the ROSTER READ is where it is: it cannot change either
 * key's identity ahead of the claim, because both facts are total functions of the rows, and it
 * cannot refuse either wake.
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
      // The two columns both facts are defined over, folded once: two `map`s over one query would
      // be two chances for the pair to disagree about what they were derived from.
      const settlements = tasks.map((task) => ({ taskId: task.id, status: task.status }));
      const fact = projectTasksSettledFact(projectId, settlements, criteria);
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

      // §1: two facts, and which one this project HAS decides which terminal it gets. The card's
      // fact is derived from the same two reads rather than from a flag on the settled one — see
      // §3 for what that buys and what it cost to learn.
      const landed = projectAcceptanceLandedFact(projectId, settlements, criteria);
      const outcome = landed
        ? await this.deliveries.deliver(landed, authorize)
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
