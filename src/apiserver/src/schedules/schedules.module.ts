import { Module } from '@nestjs/common';

import { ScheduleReadsService } from './schedule-reads.service';
import { SchedulesService } from './schedules.service';

/**
 * Scheduled tasks' domain (docs/scheduled-tasks-design.md) and its reads. The REST doors are in
 * ScheduleDoorsModule, the MCP tools' runner doors in RunnerApiModule.
 */
@Module({
  providers: [SchedulesService, ScheduleReadsService],
  exports: [SchedulesService, ScheduleReadsService],
})
export class SchedulesModule {}
