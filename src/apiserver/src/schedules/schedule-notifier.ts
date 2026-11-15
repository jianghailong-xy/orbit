import { Injectable } from '@nestjs/common';

import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { ScheduleAlert, ScheduleNotifier } from './schedule-attention';

/**
 * Who hears (docs/scheduled-tasks-design.md §7.3), sent: the push to the owner's devices and Feishu, and, for an
 * alert that filed a Waiting on you item, the nudge that tells the item's session row its needs-you count moved —
 * the same two things OwnerRequestsService.file does for a request a session files.
 */
@Injectable()
export class PushScheduleNotifier implements ScheduleNotifier {
  constructor(
    private readonly push: PushService,
    private readonly realtime: RealtimeService,
  ) {}

  async notify(alert: ScheduleAlert): Promise<void> {
    if (alert.ownerRequestId && 'sessionId' in alert.opens) this.realtime.publishSessionUpdated(alert.opens.sessionId);
    await this.push.notifySchedule(alert);
  }
}
