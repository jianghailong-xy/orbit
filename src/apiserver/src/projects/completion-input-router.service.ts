import { Injectable } from '@nestjs/common';

import type { CoordinatorWakeEvent, WakeFact } from './coordinator-wake';
import {
  CoordinatorWakeService,
  type WakeAuthorizer,
} from './coordinator-wake.service';
import type { CompletionInputConsumer } from './completion-input';
import {
  CRITERION_READY_CONSUMER,
  CriterionReadyProducer,
  type CriterionReadyDelivery,
} from './criterion-ready.producer';
import {
  CRITERION_UNLANDED_CONSUMER,
  CriterionUnlandedProducer,
  type CriterionUnlandedDelivery,
} from './criterion-unlanded.producer';
import type { MechanicalAction } from './mechanical-disposition';
import {
  ProjectTasksSettledProducer,
  type SettledProjectDelivery,
} from './project-tasks-settled.producer';
import {
  TASK_EXCEPTION_CONSUMER,
  TaskExceptionInputProducer,
} from './task-exception-input.producer';
import { WakeDispositionService, type WakeSpend } from './wake-disposition.service';

export const COMPLETION_INPUT_DELIVERY_FAILED = 'COMPLETION_INPUT_DELIVERY_FAILED';

/**
 * One spent fact: where it ended, and either the action it settles or the blocker it raised.
 *
 * Both ride beside the outcome rather than replacing it, because they answer different questions —
 * "is this fact recorded", "what does the round it is about call for", "does somebody have to look
 * at it first" — and a caller that only wants the first must not have to know the others exist.
 *
 * Never both at once, and `spend` is where that is enforced rather than here: a delivery a person
 * has to decide about is not a delivery whose merge anybody may compute.
 */
export type SpentFact = (CompletionInputRouteOutcome | WakeSpend) & {
  action?: MechanicalAction;
  blockerKind?: string;
};

export type CompletionInputRouteOutcome =
  | { outcome: 'CONSUMED'; wakeId: string; idempotencyKey: string; consumer: CompletionInputConsumer }
  | { outcome: 'ALREADY_AWAKE'; idempotencyKey: string }
  | { outcome: 'REFUSED'; wakeId: string; idempotencyKey: string; refusalCode: string };

/**
 * `route`'s default: a committed input may wake its coordinator.
 *
 * Right for the one fact that eats it — an evidence revision an agent chose to submit is bounded by
 * the agent that submitted it. Wrong for every fact DERIVED from a world that can go round again,
 * which is why `routeTaskExceptions`, `routeReadyCriteria` and `routeUnlandedCriteria` below all
 * pass their producer's authorizer rather than letting this stand in for one.
 */
const ALLOW_COMMITTED_INPUT: WakeAuthorizer = async () => ({ allowed: true });

/**
 * Delivers one committed completion-input fact to one named consumer.
 *
 * The wake row is claimed before authorization, and a refusal or failed delivery releases its
 * partial-unique key. A successful consumer CASes the row to CONSUMED. There is no retry clock:
 * the producer retries only when the same committed fact is delivered again.
 */
@Injectable()
export class CompletionInputRouter {
  constructor(
    private readonly wakes: CoordinatorWakeService,
    private readonly settled: ProjectTasksSettledProducer,
    private readonly exceptions: TaskExceptionInputProducer,
    private readonly criteria: CriterionReadyProducer,
    private readonly disposition: WakeDispositionService,
    private readonly unlanded: CriterionUnlandedProducer,
  ) {}

  /**
   * Spend one derived fact: record it always, reach a coordinator only when it changes what that
   * coordinator would decide, and say what the round it is about already settles.
   *
   * The order is the whole claim. `openIfDecisive` answers first and `null` means "record it" —
   * so a fact that changes nothing still reaches the ledger through `route` below and still ends
   * CONSUMED against its named consumer. Which of the decisive terminals a fact gets — a judgment
   * session opened for it, or a message to the conversation the project already has — is that
   * unit's question too, and this door does not learn the answer beyond reporting it. No branch is
   * a refusal: an unauthorized wake is refused inside whichever one it took, by the producer's own
   * authorizer, which is handed to all of them unchanged.
   *
   * The action comes LAST and only for a fact that was allowed. A refusal — the coordinator's
   * switch, a deleted project, a convergence ledger that has stopped, no conversation to deliver
   * to — means nobody may act on this fact at all, and choosing an action anyway would compute a
   * decision the refusal exists to prevent (and, for the reds, spend a real check finding out). So
   * `REFUSED` and `ALREADY_AWAKE` carry no action: the first was not permitted, and the second
   * belongs to whoever won the key.
   *
   * And a blocker comes before the action, which is the whole of how the two tables stay apart. A
   * delivery whose ruler is in dispute, whose files nobody asked for, or whose branch will not
   * merge is a delivery somebody has to look at; computing what it would otherwise settle would be
   * offering an answer to a question this fact just established nobody may answer. So a fact that
   * raised a blocker returns with no action at all, and nothing downstream can find one on it.
   */
  private async spend(
    fact: WakeFact,
    consumer: CompletionInputConsumer,
    authorize: WakeAuthorizer,
  ): Promise<SpentFact> {
    const opened = await this.disposition.openIfDecisive(fact, authorize);
    const outcome = opened ?? await this.route(
      fact,
      consumer,
      // No side effect beyond the ledger row, so `route`'s own no-op delivery is taken. The
      // argument is named rather than dropped because the one after it may not be defaulted.
      undefined,
      authorize,
    );
    if (outcome.outcome === 'REFUSED' || outcome.outcome === 'ALREADY_AWAKE') return outcome;
    const blocker = await this.disposition.raiseBlockerIfNeeded(fact);
    if (blocker) return { ...outcome, blockerKind: blocker.kind };
    const action = await this.disposition.chooseAction(fact);
    return action ? { ...outcome, action } : outcome;
  }

  async route(
    fact: WakeFact,
    consumer: CompletionInputConsumer,
    deliver: () => void | Promise<void> = async () => undefined,
    authorize: WakeAuthorizer = ALLOW_COMMITTED_INPUT,
  ): Promise<CompletionInputRouteOutcome> {
    const claimed = await this.wakes.claim(fact, authorize);
    if (claimed.outcome !== 'WOKEN') return claimed;

    try {
      await deliver();
      const consumed = await this.wakes.consume(claimed.wakeId, consumer);
      if (!consumed) {
        throw new Error(`completion input wake ${claimed.wakeId} lost its CLAIMED state`);
      }
      return { ...claimed, outcome: 'CONSUMED', consumer };
    } catch (error) {
      await this.wakes.release(claimed.wakeId, COMPLETION_INPUT_DELIVERY_FAILED);
      throw error;
    }
  }

  /**
   * The evidence ledger's own door: one committed completion-evidence revision, recorded against
   * its named consumer AND said out loud to the conversation coordinating this project.
   *
   * WHY THE DELIVERY IS HERE RATHER THAN AT THE CALL SITE
   * ====================================================
   * `route`'s third argument has been a no-op for this fact since the judgment machinery was
   * removed on 2026-09-02: the revision was claimed, recorded and nothing happened next, which is
   * a ledger entry nobody reads. This is that argument, wired. It is a door on this router rather
   * than a closure in `TaskCompletionEvidenceService` because the performer belongs to this
   * module's graph and not to a task write — the same argument the four doors below make.
   *
   * WHY THE CONSUMER IS STILL `JUDGMENT_REQUEST_DERIVER`
   * ===================================================
   * Unchanged, and deliberately: `completion-input.ts` says the label is what these rows have
   * always said and what the CHECK still accepts, and a delivery is not a reason to rewrite the
   * vocabulary of rows already written. What changed is that something now happens BEFORE the row
   * reaches its terminal, not what the terminal is called.
   *
   * WHY A MESSAGE THAT COULD NOT BE SENT IS NOT AN ERROR HERE
   * ========================================================
   * `notifyStandingCoordinator` answers with a refusal code for every state of the world that has
   * no recipient in it — no coordinator conversation, one that ended, one still holding a message
   * it has not read. Throwing on those would release the key and re-raise at a caller whose write
   * has already committed (`coordinator-delivery.service.ts` §3), so the fact is recorded either
   * way and the refusal stays where it was decided. What a project with NO recipient at all should
   * do about it is a question this door does not answer.
   */
  async routeCompletionEvidence(fact: WakeFact): Promise<CompletionInputRouteOutcome> {
    return this.route(fact, 'JUDGMENT_REQUEST_DERIVER', async () => {
      await this.disposition.notifyStandingCoordinator(fact);
    });
  }

  /**
   * The second door: the projects whose task set one committed task write may have closed.
   *
   * `route` above ends a fact CONSUMED against a NAMED durable consumer. A fact that has to be
   * JUDGED cannot end there — its ledger row must name the session that judges it, and one fact
   * has exactly one terminal — so this hands the ids to unit T7 instead, which re-reads the
   * committed rows, derives `PROJECT_TASKS_SETTLED` and spends it on the judgment path. Its
   * guards (project gone, coordinator disabled, convergence) are its own and are not restated by
   * any caller.
   *
   * Both doors live on this one router rather than at two call sites in the task write path,
   * because a write knows what it committed and not which wake that turns into — and the fact
   * kinds still to be wired are derived from those same committed rows.
   *
   * There is deliberately no transaction client in the signature: a caller that has not committed
   * has nothing to deliver.
   */
  routeSettledProjects(
    projectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<SettledProjectDelivery[]> {
    return this.settled.afterCommit(projectIds);
  }

  /**
   * The third door: the exception facts one committed task write leaves behind.
   *
   * Same post-commit position and same generosity as `routeSettledProjects` — ids in, the producer
   * re-reads the committed rows and decides what they justify — and one difference that is the
   * whole reason this door exists rather than a fourth `route` call site somewhere else: the
   * fourth argument is passed. `ALLOW_COMMITTED_INPUT` is a defensible default for an input an
   * agent submitted on purpose; for a failure it is the hole "failed → open a successor → fail
   * again" lives in, so the convergence ledger — not this file's default — decides whether the
   * coordinator may be woken again.
   *
   * What an authorized exception is then SPENT on is `spend`'s question rather than this door's: a
   * failure whose criterion still has other work outstanding changes nothing and is recorded, and
   * one that leaves its criterion with nothing to deliver it opens the session.
   */
  async routeTaskExceptions(
    taskIds: ReadonlyArray<string | null | undefined>,
  ): Promise<TaskExceptionDelivery[]> {
    const facts = await this.exceptions.factsFor(taskIds);
    const deliveries: TaskExceptionDelivery[] = [];
    for (const fact of facts) {
      const routed = await this.spend(fact, TASK_EXCEPTION_CONSUMER, this.exceptions.authorize);
      deliveries.push({
        taskId: fact.subjectId,
        event: fact.event,
        outcome: routed.outcome,
        ...(routed.outcome === 'REFUSED' ? { refusalCode: routed.refusalCode } : {}),
        ...(routed.action ? { action: routed.action } : {}),
      });
    }
    return deliveries;
  }

  /**
   * The fourth door: the acceptance criteria one committed task write may have finished the work
   * for.
   *
   * Project ids in, for the reason `routeSettledProjects` takes them: what a write closed is not
   * something the write knows. The producer re-reads every criterion those projects state, and
   * derives at most one fact per criterion — which is the unit a coordinator reasons in. A door
   * that took the settled TASK instead could never see the criterion nobody filed any work
   * against, and that criterion is precisely the reason a project with every task settled can
   * still be nowhere near done.
   *
   * The fourth argument is passed here too. Readiness is not an exception, but it is not an input
   * an agent submitted either: work reopens and finishes again, and only the convergence ledger
   * bounds how often that may wake anybody.
   *
   * And `spend` decides the terminal here on the same terms as the door above. It answers
   * RECORD_ONLY for every criterion this producer derives a fact for — a criterion whose serving
   * work is all DONE is backed, and `wake-disposition.ts` §2 says a backed claim owes nobody a
   * JUDGMENT — which is the answer this door used to hard-code while waiting for a rule to state
   * it. What such a criterion may still owe is a merge, and §2.1 there says why that is answered
   * on the fact that reports its landing rather than a second time on this one.
   */
  async routeReadyCriteria(
    projectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<CriterionReadyDelivery[]> {
    const facts = await this.criteria.factsFor(projectIds);
    const deliveries: CriterionReadyDelivery[] = [];
    for (const fact of facts) {
      const routed = await this.spend(fact, CRITERION_READY_CONSUMER, this.criteria.authorize);
      deliveries.push({
        criterionSubjectId: fact.subjectId,
        outcome: routed.outcome,
        ...(routed.outcome === 'REFUSED' ? { refusalCode: routed.refusalCode } : {}),
        ...(routed.action ? { action: routed.action } : {}),
      });
    }
    return deliveries;
  }

  /**
   * The fifth door: the acceptance criteria whose finished work is on nobody's default branch.
   *
   * Project ids in, the same generosity, and the same producer-owned authorizer as the door above
   * — and one thing that is genuinely different about this fact, which is why it is a door rather
   * than a flag on the readiness one. "The work is done" and "the work is on `main`" are answered
   * from DIFFERENT rows written by DIFFERENT paths: a task settles through the write path this
   * router hangs off, and a merge is recorded by a runner, an agent or a person long afterwards.
   * Folding the second into the first event would key one fact on two independently moving
   * projections, and the first of them to move would spend the idempotency key the second needed.
   *
   * So the two are two facts about one criterion, and a criterion that is ready and landed simply
   * produces the first. `spend` decides the terminal on the same terms as every door here, and it
   * is deliberately not overridden: which authorized wakes are worth a coordinator's attention is
   * one rule, stated once, in the one unit every door asks. That rule reads this event's landing
   * half and no other door's — §2.1 there, because a merge is owed once — and answers it with the
   * standing conversation rather than a new session — §2.2 there, because a merge owed once must
   * not be asked of two. Both are that unit's readings and neither is a decision taken here.
   */
  async routeUnlandedCriteria(
    projectIds: ReadonlyArray<string | null | undefined>,
  ): Promise<CriterionUnlandedDelivery[]> {
    const facts = await this.unlanded.factsFor(projectIds);
    const deliveries: CriterionUnlandedDelivery[] = [];
    for (const fact of facts) {
      const routed = await this.spend(fact, CRITERION_UNLANDED_CONSUMER, this.unlanded.authorize);
      deliveries.push({
        criterionSubjectId: fact.subjectId,
        outcome: routed.outcome,
        ...(routed.outcome === 'REFUSED' ? { refusalCode: routed.refusalCode } : {}),
        ...(routed.action ? { action: routed.action } : {}),
        ...(routed.blockerKind ? { blockerKind: routed.blockerKind } : {}),
      });
    }
    return deliveries;
  }
}

/** What one exception fact's delivery answered, for a caller that has to say what happened. */
export interface TaskExceptionDelivery {
  taskId: string;
  event: CoordinatorWakeEvent;
  /** Both terminals: `CONSUMED` for a fact that was recorded, `OPENED` for one that was judged. */
  outcome: CompletionInputRouteOutcome['outcome'] | WakeSpend['outcome'];
  refusalCode?: string;
  /** What the round this fact is about settles without a judgement, when anything does. */
  action?: MechanicalAction;
}
