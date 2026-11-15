import { Module } from '@nestjs/common';

import { PushModule } from '../push/push.module';
import { SCHEDULE_NOTIFIER } from './schedule-attention';
import { PushScheduleNotifier } from './schedule-notifier';
import { SchedulesService } from './schedules.service';

/** Scheduled tasks' domain (docs/scheduled-tasks-design.md). Its tools and REST doors come in later tasks. */
@Module({
  imports: [PushModule],
  providers: [
    PushScheduleNotifier,
    { provide: SCHEDULE_NOTIFIER, useExisting: PushScheduleNotifier },
    SchedulesService,
  ],
  exports: [SchedulesService],
})
export class SchedulesModule {}
