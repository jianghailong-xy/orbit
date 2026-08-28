import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClientVersionInterceptor } from './common/client-version.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SessionsModule } from './sessions/sessions.module';
import { SessionTagsModule } from './session-tags/session-tags.module';
import { TasksModule } from './tasks/tasks.module';
import { TaskListsModule } from './task-lists/task-lists.module';
import { ProjectsModule } from './projects/projects.module';
import { RunnersModule } from './runners/runners.module';
import { RunnerApiModule } from './runner-api/runner-api.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { SharedModule } from './shared/shared.module';
import { PushModule } from './push/push.module';
import { ProvidersModule } from './providers/providers.module';
import { OutcomeReconcilerModule } from './outcome-reconciler/outcome-reconciler.module';
import { OutcomeWatchdogModule } from './outcome-watchdog/outcome-watchdog.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RealtimeModule,
    EventsModule,
    MetricsModule,
    QueueModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    SessionsModule,
    SessionTagsModule,
    TasksModule,
    TaskListsModule,
    ProjectsModule,
    RunnersModule,
    RunnerApiModule,
    AttachmentsModule,
    SharedModule,
    PushModule,
    ProvidersModule,
    OutcomeReconcilerModule,
    // API adapters may inject the storage boundary, but the poller is intentionally absent. The
    // standalone outcome-watchdog/main process owns collection and survives a reconciler stop.
    OutcomeWatchdogModule,
  ],
  // Registered here rather than in main.ts (where WorkspaceAliasInterceptor is) because it needs
  // PrismaService injected, which only the DI container can provide.
  providers: [{ provide: APP_INTERCEPTOR, useClass: ClientVersionInterceptor }],
})
export class AppModule {}
