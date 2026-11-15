import { Module } from '@nestjs/common';

import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SCHEDULE_NOTIFIER } from './schedule-attention';
import { PushScheduleNotifier } from './schedule-notifier';
import { SessionsScheduleRunPort } from './schedule-run-sessions';
import { SCHEDULE_RUN_SESSIONS, ScheduleRunsService } from './schedule-runs.service';
import { ScheduleWorker } from './schedule.worker';

/**
 * A schedule's runs (docs/scheduled-tasks-design.md §5–§7): the firing worker and ScheduleRunsService, whose run
 * report, Run now and Stop this run S4's tools and REST call. Separate from SchedulesModule, which needs no session.
 */
@Module({
  imports: [SessionsModule, PushModule],
  providers: [
    PushScheduleNotifier,
    { provide: SCHEDULE_NOTIFIER, useExisting: PushScheduleNotifier },
    SessionsScheduleRunPort,
    { provide: SCHEDULE_RUN_SESSIONS, useExisting: SessionsScheduleRunPort },
    ScheduleRunsService,
    ScheduleWorker,
  ],
  exports: [ScheduleRunsService],
})
export class ScheduleRunsModule {}
