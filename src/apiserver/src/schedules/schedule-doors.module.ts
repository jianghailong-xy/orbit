import { Module } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { ScheduleRunsModule } from './schedule-runs.module';
import { ScheduleChangeConversations } from './schedule-change-conversation';
import { SchedulePageChats } from './schedule-page-chat';
import { SchedulesController } from './schedules.controller';
import { SchedulesModule } from './schedules.module';

/** The REST doors of scheduled tasks (schedules.controller.ts): read, control, and the owner's press on a card. */
@Module({
  imports: [SchedulesModule, ScheduleRunsModule, SessionsModule],
  controllers: [SchedulesController],
  providers: [ScheduleChangeConversations, SchedulePageChats],
})
export class ScheduleDoorsModule {}
