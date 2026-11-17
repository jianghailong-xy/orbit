import { Injectable } from '@nestjs/common';

import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { ConditionAlert, ConditionNotifier } from './condition-attention';

/**
 * A can't-read alert, sent (condition-attention.ts): the push to the owner's devices and Feishu, and, when it filed a
 * Waiting on you item, the nudge that tells the item's session row its needs-you count moved.
 */
@Injectable()
export class PushConditionNotifier implements ConditionNotifier {
  constructor(
    private readonly push: PushService,
    private readonly realtime: RealtimeService,
  ) {}

  async notify(alert: ConditionAlert): Promise<void> {
    if (alert.ownerRequestId && alert.sessionId) this.realtime.publishSessionUpdated(alert.sessionId);
    await this.push.notifyCondition(alert);
  }
}
