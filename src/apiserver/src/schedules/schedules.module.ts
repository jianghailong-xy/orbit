import { Module } from '@nestjs/common';

import { PushModule } from '../push/push.module';
import { SCHEDULE_NOTIFIER } from './schedule-attention';
import { PushScheduleNotifier } from './schedule-notifier';
import { ScheduleReadsService } from './schedule-reads.service';
import { SchedulesService } from './schedules.service';

/**
 * Scheduled tasks' domain (docs/scheduled-tasks-design.md) and its reads. The REST doors are in
 * ScheduleDoorsModule, the MCP tools' runner doors in RunnerApiModule.
 */
@Module({
  imports: [PushModule],
  providers: [
    PushScheduleNotifier,
    { provide: SCHEDULE_NOTIFIER, useExisting: PushScheduleNotifier },
    SchedulesService,
    ScheduleReadsService,
  ],
  exports: [SchedulesService, ScheduleReadsService],
})
export class SchedulesModule {}
