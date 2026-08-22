import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClientVersionInterceptor } from './common/client-version.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { EventsModule } from './events/events.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SessionsModule } from './sessions/sessions.module';
import { SessionTagsModule } from './session-tags/session-tags.module';
import { InboxModule } from './inbox/inbox.module';
import { TasksModule } from './tasks/tasks.module';
import { TaskListsModule } from './task-lists/task-lists.module';
import { ProjectsModule } from './projects/projects.module';
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
    WorkspacesModule,
    SessionsModule,
    SessionTagsModule,
    InboxModule,
    TasksModule,
    TaskListsModule,
    ProjectsModule,
    RunnersModule,
    RunnerApiModule,
    AttachmentsModule,
    SharedModule,
    PushModule,
    ProvidersModule,
  ],
  // Registered here rather than in main.ts (where WorkspaceAliasInterceptor is) because it needs
  // PrismaService injected, which only the DI container can provide.
  providers: [{ provide: APP_INTERCEPTOR, useClass: ClientVersionInterceptor }],
})
export class AppModule {}
