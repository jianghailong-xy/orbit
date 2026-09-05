import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { CompletionInputConsumer } from './completion-input';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { WakeFact, criterionReadyFact } from './coordinator-wake';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';
import { criterionKeyOf } from './project-acceptance';

/** The project disappeared between the committed criterion read and the wake's authorization. */
export const CRITERION_READY_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/**
 * The project still exists and its automation switch is off at authorization time.
 *
 * Spelled as the two sibling producers spell it, because it is the same refusal about the same
 * column: a refusal of automation, not a claim that the committed criterion fact was false.
 */
export const CRITERION_READY_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/**
 * Who this fact is recorded FOR today.
 *
 * A criterion whose work has finished is a strong candidate for a judgment session, and this unit
 * deliberately does not open one: "does this event change the coordinator's decision" is the
 * question the unit after this one answers, over every event kind at once, and answering it here
 * for one of them would be that decision made twice. So the terminal claimed is the honest one —
 * the fact is durable, idempotent and convergence-bounded, on the surface a person reads.
 */
export const CRITERION_READY_CONSUMER: CompletionInputConsumer = 'HUMAN_INBOX';

/** What one criterion's delivery answered, for a caller that has to say what happened. */
export interface CriterionReadyDelivery {
  /** The criterion's wake subject — `<projectId>:<criterionKey>`, which is not any task's id. */
  criterionSubjectId: string;
  outcome: 'CONSUMED' | 'ALREADY_AWAKE' | 'REFUSED';
  refusalCode?: string;
}

/**
 * The `CRITERION_READY` facts a committed task write justifies, and the authorizer they are spent
 * on.
 *
 * WHY THE UNIT IS A CRITERION AND NOT A TASK
 * ==========================================
 * A coordinator reasons about whether one stated condition is now backed by finished work, and
 * cutting the event per TASK is wrong at both ends. It is a false POSITIVE for a project whose
 * tasks have all settled while some criterion has no work serving it at all — that project is a
 * long way from done. It is a false NEGATIVE for a project every criterion of which is met while a
 * forgotten task sits open — nobody is ever asked. So the fact is derived per criterion, from that
 * criterion's own serving work, and `criterionReadyFact` owns the predicate: a non-empty serving
 * set, every member of it DONE. A criterion nobody serves derives nothing, which is the same
 * `NO_WORK_SERVES_IT` the satisfaction derivation reports and the reason it is a clause there
 * rather than a vacuous truth.
 *
 * DONE rather than settled, and that is `criterionReadyFact`'s decision rather than a predicate in
 * the query here: a CANCELLED task serves no criterion, so a criterion whose work was abandoned
 * never becomes ready and no writer of this fact gets to hold a second opinion about it.
 *
 * WHY THE AUTHORIZER IS THIS UNIT'S AND NOT THE ROUTER'S DEFAULT
 * =============================================================
 * `CompletionInputRouter.route`'s default allows every committed input, which is right for a
 * revision an agent chose to submit and wrong here: work reopens, finishes again and re-derives
 * readiness, and nothing about that cycle bounds itself. The convergence ledger is what bounds it,
 * so `authorize` below is composed cheapest refusal first with `convergence.authorizeWake` LAST —
 * a convergence pass is charged when it runs, so no cheaper refusal may follow it.
 *
 * WHY IT IS POST-COMMIT AND RE-READS
 * ==================================
 * Same reason its two siblings state: the fact's version is a digest of the rows that ACTUALLY
 * committed, and the write that settled one serving task cannot see the rest of the set. Callers
 * pass project ids generously; this unit decides what, if anything, they justify.
 */
@Injectable()
export class CriterionReadyProducer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly convergence: CoordinatorConvergenceService,
  ) {}

  /**
   * The `CRITERION_READY` facts these committed projects justify, in criterion order.
   *
   * Empty is the ordinary answer. `criterion_definition_id` is what makes a task serve a criterion
   * and is written once, when the task is created, so the serving set of a criterion moves only
   * when work is filed against it or removed — never under an edit to work that already serves it.
   */
  async factsFor(projectIds: ReadonlyArray<string | null | undefined>): Promise<WakeFact[]> {
    const ids = [...new Set(projectIds.filter((id): id is string => !!id))].sort();
    if (ids.length === 0) return [];

    const definitions = await this.prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: { in: ids } },
      select: {
        id: true,
        projectId: true,
        servingTasks: { select: { id: true, status: true } },
      },
      orderBy: [{ projectId: 'asc' }, { ordinal: 'asc' }],
    });

    return definitions
      .map((definition) => criterionReadyFact(
        definition.projectId,
        criterionKeyOf(definition.id),
        definition.servingTasks.map((task) => ({ taskId: task.id, status: task.status })),
      ))
      .filter((fact): fact is WakeFact => fact !== null);
  }

  /**
   * The authorizer every criterion-readiness delivery must be routed with.
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
    if (!project) return { allowed: false, refusalCode: CRITERION_READY_WAKE_PROJECT_GONE };
    if (!project.coordinatorEnabled) {
      return { allowed: false, refusalCode: CRITERION_READY_WAKE_COORDINATOR_DISABLED };
    }
    return this.convergence.authorizeWake(fact, claim);
  };
}
