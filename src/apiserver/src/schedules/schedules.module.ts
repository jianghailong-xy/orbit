import { Module } from '@nestjs/common';

import { SchedulesService } from './schedules.service';

/** Scheduled tasks' domain (docs/scheduled-tasks-design.md). Its tools and REST doors come in later tasks. */
@Module({
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
