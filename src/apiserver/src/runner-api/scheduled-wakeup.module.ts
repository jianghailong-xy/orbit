import { Module } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { ScheduledWakeupWorker } from './scheduled-wakeup.worker';

/**
 * The scheduled-wakeup worker: one loop per replica that files the wakeups sessions asked for as turns
 * once they are due, through SessionsService's queue entry point. PrismaService is global.
 */
@Module({
  imports: [SessionsModule],
  providers: [ScheduledWakeupWorker],
  exports: [ScheduledWakeupWorker],
})
export class ScheduledWakeupModule {}
