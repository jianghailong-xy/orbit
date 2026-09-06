import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { WakeFact, criterionSubjectId } from './coordinator-wake';
import type { WakeAuthorizer } from './coordinator-wake.service';
import { criterionKeyOf } from './project-acceptance';
import { type CriterionWithLandingFacts, criterionLanding } from './project-criterion-landing';
import { CriterionState, criterionCoverage, wakeDisposition } from './wake-disposition';

/** What a fact that DID change the decision was spent on, for a caller that has to report it. */
export interface WakeSpend {
  outcome: 'OPENED' | 'ALREADY_AWAKE' | 'ALREADY_OPEN' | 'REFUSED';
  refusalCode?: string;
}

/**
 * The durable half of `wake-disposition.ts`: read the criteria the fact bears on, decide, and open
 * only when the answer is yes.
 *
 * WHY THE READ COMES BEFORE THE CLAIM, AND WHY THAT IS SAFE
 * ========================================================
 * `coordinator-wake.ts` §1 forbids letting an authorization decision run before the idempotency
 * key is claimed, because a key computed after a permission branch makes the winner of a race
 * depend on a question about permission. This read is not that. It cannot change the key — the key
 * is a total function of the fact — and it cannot refuse the wake: both of its answers end in a
 * status inside 0174's partial unique index, so whichever branch a delivery takes it claims the
 * same key and loses the same races. Two concurrent deliveries that read different coverage still
 * produce exactly one terminal, because only one of them wins the INSERT.
 *
 * WHY THIS IS NOT ON THE ROUTER
 * =============================
 * `CompletionInputRouter` records facts against named consumers and deliberately opens no session
 * of its own — a claim `completion-input.spec.ts` holds it to over its source. Opening one is
 * `CoordinatorJudgmentService`'s, and choosing between the two terminals is this unit's, which is
 * why the router asks and does not decide.
 */
@Injectable()
export class WakeDispositionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
  ) {}

  /**
   * Open the one judgment session this fact justifies, or `null` when it justifies none.
   *
   * `null` is the caller's instruction to record the fact and stop — NOT a refusal, and not a
   * failure. The authorizer is handed straight through rather than consulted here, so a wake the
   * coordinator's switch or the convergence ledger would refuse is refused on the same terms in
   * both branches: this unit decides what an allowed wake is spent on and never whether it is
   * allowed.
   */
  async openIfDecisive(fact: WakeFact, authorize: WakeAuthorizer): Promise<WakeSpend | null> {
    const criteria = await this.statesOf(fact);
    if (wakeDisposition(fact.event, criteria) === 'RECORD_ONLY') return null;

    const judged = await this.judgments.wake(fact, authorize);
    return judged.outcome === 'REFUSED'
      ? { outcome: 'REFUSED', refusalCode: judged.refusalCode }
      : { outcome: judged.outcome };
  }

  /**
   * The state of every acceptance criterion this fact bears on, re-read after the commit.
   *
   * Which criteria a fact bears on is decided by its SUBJECT and not by its event: work names the
   * one criterion it was filed against, and a criterion fact names itself. Every other subject
   * bears on none, which §3 records and does not judge — the project-scoped fact has its own door
   * and is not delivered through this one.
   *
   * Both dimensions are read here, for every fact, and neither is taken from the fact itself. A
   * fact's `detail` is display and diagnosis (`coordinator-wake.ts` says so in as many words), so
   * a landing answer copied out of it would be this unit deciding on what was true when the fact
   * was DERIVED rather than on what is true now — and "the merge landed in between" is precisely
   * the case where those differ and where nobody should be woken. The receipts arrive on the
   * criterion's serving work, which is the same nested read `project-criterion-landing.ts` makes
   * for the person looking at the same question.
   */
  private async statesOf(fact: WakeFact): Promise<CriterionState[]> {
    if (fact.subjectType === 'TASK') {
      const served = await this.prisma.projectAcceptanceCriterionDefinition.findFirst({
        where: { projectId: fact.projectId, servingTasks: { some: { id: fact.subjectId } } },
        select: { id: true, servingTasks: { select: SERVING_WORK } },
      });
      if (!served) return [];
      return [state(served, criterionCoverage(settlements(served.servingTasks), fact.subjectId))];
    }

    if (fact.subjectType === 'CRITERION') {
      const stated = await this.prisma.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: fact.projectId },
        select: { id: true, servingTasks: { select: SERVING_WORK } },
      });
      // Matched by re-deriving the subject rather than by parsing it: the spelling of a criterion's
      // wake subject belongs to the function that writes it, and a second parser of it here would
      // be a second definition of what a criterion is called.
      return stated
        .filter((row) => criterionSubjectId(fact.projectId, criterionKeyOf(row.id)) === fact.subjectId)
        .map((row) => state(row, criterionCoverage(settlements(row.servingTasks))));
    }

    return [];
  }
}

/** What one criterion's serving work has to carry for both halves of the rule to be answerable. */
const SERVING_WORK = {
  id: true,
  status: true,
  mergeReceipts: { select: { result: true, targetBranch: true } },
} as const;

function settlements(tasks: ReadonlyArray<{ id: string; status: string }>) {
  return tasks.map((task) => ({ taskId: task.id, status: task.status }));
}

/**
 * One criterion's row, folded into the pair the rule reads.
 *
 * The landing half goes through `criterionLanding` — one row at a time, because that is the unit
 * this fact is decided in — rather than through a receipt test written here. The fold is where
 * "landed" is defined, and calling it is how this unit stays a reader of that definition instead
 * of becoming a second author of it.
 */
function state(criterion: CriterionWithLandingFacts, coverage: CriterionState['coverage']) {
  return { coverage, landing: criterionLanding([criterion])[0]!.landing };
}
