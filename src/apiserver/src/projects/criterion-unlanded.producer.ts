import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { CompletionInputConsumer } from './completion-input';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { WakeFact, criterionUnlandedFact } from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';
import type { MechanicalAction } from './mechanical-disposition';
import { criterionKeyOf } from './project-acceptance';
import { criterionLanding } from './project-criterion-landing';

/** The project disappeared between the committed criterion read and the wake's authorization. */
export const CRITERION_UNLANDED_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/**
 * The project still exists and its automation switch is off at authorization time.
 *
 * Spelled as the three sibling producers spell it, because it is the same refusal about the same
 * column: a refusal of automation, not a claim that the committed criterion fact was false.
 */
export const CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/**
 * Who this fact is recorded FOR, in the case where it is only recorded.
 *
 * The same surface its readiness sibling ends on, and still for the same reason: what an authorized
 * wake is SPENT on is `wake-disposition.ts`'s question and not this unit's, so deciding here that
 * this one event is different would be making that decision twice, in two places, with nothing
 * keeping the two agreeing.
 *
 * What has changed is that rule's answer, not where it is asked. A criterion whose serving work is
 * all DONE and whose result is not known to be on the default branch is now handed to the project's
 * standing coordinator conversation — §2.1 there says why the fact reporting the landing is the one
 * that gets a coordinator at all, and §2.2 why the one it gets is the conversation that already
 * exists rather than a session opened for it. This consumer is what the OTHER case ends against:
 * the criterion whose receipts arrived between the derivation of this fact and its delivery, which
 * is a merge nobody owes any more and a person can still read about.
 */
export const CRITERION_UNLANDED_CONSUMER: CompletionInputConsumer = 'HUMAN_INBOX';

/** What one criterion's delivery answered, for a caller that has to say what happened. */
export interface CriterionUnlandedDelivery {
  /** The criterion's wake subject — `<projectId>:<criterionKey>`, which is not any task's id. */
  criterionSubjectId: string;
  outcome:
    | 'CONSUMED'
    | 'ALREADY_AWAKE'
    | 'REFUSED'
    | 'OPENED'
    | 'ALREADY_OPEN'
    | 'DELIVERED'
    | 'ALREADY_DELIVERED';
  refusalCode?: string;
  /** What the round behind this fact settles without a judgement, when anything does. */
  action?: MechanicalAction;
}

/**
 * The `CRITERION_UNLANDED` facts a committed task write justifies, and the authorizer they are
 * spent on.
 *
 * WHAT THIS IS FOR
 * ================
 * "Did the work land?" was computed on every project read and consumed by nothing: the answer was
 * served beside the criterion it is about, and served is where it stopped. On 2026-09-05 that cost
 * something measurable — a finished task's result sat outside `main` for four hours because the
 * only thing that would have noticed was a person deciding to look. The derivation was never
 * wrong; it simply was not an input to anything. This unit makes it one.
 *
 * WHY THE ANSWER IS BORROWED AND NOT RECOMPUTED
 * =============================================
 * `criterionLanding` is the reading of merge receipts — which two results count, which branch
 * names count, and why the absence of a receipt is absence of evidence rather than evidence of
 * absence. All of that is one fold in one module, and this producer calls it rather than filtering
 * receipts in its own WHERE clause. A second implementation of "landed" would be a second answer a
 * person could be shown, and the two would diverge on exactly the case the fold was written for.
 *
 * The query therefore selects what the fold needs — every serving task's receipts — and hands the
 * rows over unaltered. What it adds is the settlement column, because the second half of this fact
 * is the readiness predicate `criterionUnlandedFact` owns.
 *
 * WHY THE AUTHORIZER IS THIS UNIT'S AND NOT THE ROUTER'S DEFAULT
 * =============================================================
 * `CompletionInputRouter.route`'s default allows every committed input, which is right for a
 * revision an agent chose to submit and wrong here, more sharply than for any sibling: what a
 * coordinator does about unlanded work is merge it, merging can fail, and failing leaves the fact
 * exactly as true as it was. "Not landed → wake → could not land → wake" is a perpetual motion
 * machine unless something bounds it, so `authorize` below is composed cheapest refusal first with
 * `convergence.authorizeWake` LAST — a convergence pass is charged when it runs, so no cheaper
 * refusal may follow it.
 *
 * WHY IT IS POST-COMMIT AND RE-READS
 * ==================================
 * Same reason its three siblings state: the fact's version is a digest of the rows that ACTUALLY
 * committed, and the write that settled one serving task cannot see the rest of the set — nor the
 * receipts, which are written by an entirely different path. Callers pass project ids generously;
 * this unit decides what, if anything, they justify.
 */
@Injectable()
export class CriterionUnlandedProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
  ) {}

  /**
   * The `CRITERION_UNLANDED` facts these committed projects justify, in criterion order.
   *
   * Empty is the ordinary answer, and it is the ordinary answer for two quite different reasons —
   * the criterion still has work running, or the criterion's work is all on `main`. Only the fact
   * itself distinguishes them, which is why nothing here reports "no".
   */
  async factsFor(projectIds: ReadonlyArray<string | null | undefined>): Promise<WakeFact[]> {
    const ids = [...new Set(projectIds.filter((id): id is string => !!id))].sort();
    if (ids.length === 0) return [];

    const definitions = await this.prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: { in: ids } },
      select: {
        id: true,
        projectId: true,
        servingTasks: {
          select: {
            id: true,
            status: true,
            mergeReceipts: { select: { result: true, targetBranch: true } },
          },
        },
      },
      orderBy: [{ projectId: 'asc' }, { ordinal: 'asc' }],
    });

    // One pass over the same rows, so the landing answer this fact carries is the one the fold
    // gives for that criterion rather than a per-criterion re-derivation that could disagree.
    const landed = new Map(
      criterionLanding(definitions).map((answer) => [answer.definitionId, answer.landing]),
    );

    return definitions
      .map((definition) => criterionUnlandedFact(
        definition.projectId,
        criterionKeyOf(definition.id),
        definition.servingTasks.map((task) => ({ taskId: task.id, status: task.status })),
        landed.get(definition.id) ?? 'UNKNOWN',
      ))
      .filter((fact): fact is WakeFact => fact !== null);
  }

  /**
   * The authorizer every unlanded-criterion delivery must be routed with.
   *
   * A property field rather than a method, for the reason `CoordinatorConvergenceService` states
   * about its own: handed to `route` as a bare method it would arrive without its `this`, and a
   * throw inside an authorizer is recorded as `WAKE_AUTHORIZATION_FAILED` — a wiring mistake
   * wearing the costume of a transient failure.
   */
  readonly authorize: WakeAuthorizer = async (fact, claim): Promise<WakeAuthorization> => {
    // T2's order is claim first, authorize second. This read stays here rather than in `factsFor`:
    // hoisting it would make permission decide who wins the idempotency key.
    const project = await this.prisma.project.findUnique({
      where: { id: fact.projectId },
      select: { coordinatorEnabled: true },
    });
    if (!project) return { allowed: false, refusalCode: CRITERION_UNLANDED_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };
}
