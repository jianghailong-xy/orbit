import { Injectable } from '@nestjs/common';

import type { CoordinatorWakeEvent, WakeFact } from './coordinator-wake';
import {
  CoordinatorWakeService,
  type WakeAuthorizer,
} from './coordinator-wake.service';
import type { CompletionInputConsumer } from './completion-input';
import {
  ProjectTasksSettledProducer,
  type SettledProjectDelivery,
} from './project-tasks-settled.producer';
import {
  TASK_EXCEPTION_CONSUMER,
  TaskExceptionInputProducer,
} from './task-exception-input.producer';

export const COMPLETION_INPUT_DELIVERY_FAILED = 'COMPLETION_INPUT_DELIVERY_FAILED';

export type CompletionInputRouteOutcome =
  | { outcome: 'CONSUMED'; wakeId: string; idempotencyKey: string; consumer: CompletionInputConsumer }
  | { outcome: 'ALREADY_AWAKE'; idempotencyKey: string }
  | { outcome: 'REFUSED'; wakeId: string; idempotencyKey: string; refusalCode: string };

/**
 * `route`'s default: a committed input may wake its coordinator.
 *
 * Right for the one fact that eats it — an evidence revision an agent chose to submit is bounded by
 * the agent that submitted it. Wrong for every EXCEPTION, which is why `routeTaskExceptions` below
 * passes its producer's authorizer rather than letting this stand in for one.
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
  ) {}

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
   */
  async routeTaskExceptions(
    taskIds: ReadonlyArray<string | null | undefined>,
  ): Promise<TaskExceptionDelivery[]> {
    const facts = await this.exceptions.factsFor(taskIds);
    const deliveries: TaskExceptionDelivery[] = [];
    for (const fact of facts) {
      const routed = await this.route(
        fact,
        TASK_EXCEPTION_CONSUMER,
        // No side effect beyond the ledger row, so `route`'s own no-op delivery is taken. The
        // argument is named rather than dropped because the one after it may not be defaulted.
        undefined,
        this.exceptions.authorize,
      );
      deliveries.push({
        taskId: fact.subjectId,
        event: fact.event,
        outcome: routed.outcome,
        ...(routed.outcome === 'REFUSED' ? { refusalCode: routed.refusalCode } : {}),
      });
    }
    return deliveries;
  }
}

/** What one exception fact's delivery answered, for a caller that has to say what happened. */
export interface TaskExceptionDelivery {
  taskId: string;
  event: CoordinatorWakeEvent;
  outcome: CompletionInputRouteOutcome['outcome'];
  refusalCode?: string;
}
