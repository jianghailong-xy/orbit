import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { EventsModule } from './events/events.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AgentsModule } from './agents/agents.module';
import { SessionsModule } from './sessions/sessions.module';
import { TasksModule } from './tasks/tasks.module';
import { TaskListsModule } from './task-lists/task-lists.module';
import { RunnersModule } from './runners/runners.module';
import { RunnerApiModule } from './runner-api/runner-api.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { SharedModule } from './shared/shared.module';
import { PushModule } from './push/push.module';
import { ProvidersModule } from './providers/providers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RealtimeModule,
    EventsModule,
    QueueModule,
    AuthModule,
    UsersModule,
    AgentsModule,
    SessionsModule,
    TasksModule,
    TaskListsModule,
    RunnersModule,
    RunnerApiModule,
    AttachmentsModule,
    SharedModule,
    PushModule,
    ProvidersModule,
  ],
})
export class AppModule {}
