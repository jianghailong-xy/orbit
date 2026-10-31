import { Module } from '@nestjs/common';

import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ScheduledWakeupWorker } from './scheduled-wakeup.worker';

/**
 * The scheduled-wakeup worker: one loop per replica that files the wakeups sessions asked for as turns
 * once they are due, through SessionsService's queue entry point, and tells the owner through PushService
 * when a loop has stopped running or a wakeup was dropped. PrismaService is global.
 */
@Module({
  imports: [SessionsModule, PushModule],
  providers: [ScheduledWakeupWorker],
  exports: [ScheduledWakeupWorker],
})
export class ScheduledWakeupModule {}
