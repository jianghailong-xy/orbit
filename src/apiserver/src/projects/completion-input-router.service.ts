import { Injectable } from '@nestjs/common';

import type { WakeFact } from './coordinator-wake';
import {
  CoordinatorWakeService,
  type WakeAuthorizer,
} from './coordinator-wake.service';
import type { CompletionInputConsumer } from './completion-input';

export const COMPLETION_INPUT_DELIVERY_FAILED = 'COMPLETION_INPUT_DELIVERY_FAILED';

export type CompletionInputRouteOutcome =
  | { outcome: 'CONSUMED'; wakeId: string; idempotencyKey: string; consumer: CompletionInputConsumer }
  | { outcome: 'ALREADY_AWAKE'; idempotencyKey: string }
  | { outcome: 'REFUSED'; wakeId: string; idempotencyKey: string; refusalCode: string };

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
  constructor(private readonly wakes: CoordinatorWakeService) {}

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
}
