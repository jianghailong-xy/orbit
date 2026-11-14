import { Module } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { SessionsScheduleRunPort } from './schedule-run-sessions';
import { SCHEDULE_RUN_SESSIONS, ScheduleRunsService } from './schedule-runs.service';
import { ScheduleWorker } from './schedule.worker';

/**
 * A schedule's runs (docs/scheduled-tasks-design.md §5–§7): the firing worker and ScheduleRunsService, whose run
 * report, Run now and Stop this run S4's tools and REST call. Separate from SchedulesModule, which needs no session.
 */
@Module({
  imports: [SessionsModule],
  providers: [
    SessionsScheduleRunPort,
    { provide: SCHEDULE_RUN_SESSIONS, useExisting: SessionsScheduleRunPort },
    ScheduleRunsService,
    ScheduleWorker,
  ],
  exports: [ScheduleRunsService],
})
export class ScheduleRunsModule {}
