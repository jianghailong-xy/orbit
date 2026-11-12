import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClientVersionInterceptor } from './common/client-version.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { SessionsModule } from './sessions/sessions.module';
import { SessionTagsModule } from './session-tags/session-tags.module';
import { SessionFoldersModule } from './session-folders/session-folders.module';
import { TasksModule } from './tasks/tasks.module';
import { TaskListsModule } from './task-lists/task-lists.module';
import { LinkPreviewsModule } from './link-previews/link-previews.module';
import { WatchesModule } from './watches/watches.module';
import { OwnerRequestsModule } from './owner-requests/owner-requests.module';
import { ProjectsModule } from './projects/projects.module';
import { RunnersModule } from './runners/runners.module';
import { RunnerApiModule } from './runner-api/runner-api.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { SharedModule } from './shared/shared.module';
import { ShareLinksModule } from './share-links/share-links.module';
import { SessionGuestsModule } from './session-guests/session-guests.module';
import { PushModule } from './push/push.module';
import { ProvidersModule } from './providers/providers.module';
import { ProviderEngineMigrationModule } from './providers/provider-engine-migration.module';
import { LandingObservationBackfillModule } from './projects/landing-observation-backfill.module';
import { OutcomeReconcilerHttpModule } from './outcome-reconciler/outcome-reconciler-http.module';
import { WatchEvaluatorModule } from './watches/watch-evaluator.module';
import { WatchDeliveryModule } from './watches/watch-delivery.module';
import { ScheduledWakeupModule } from './runner-api/scheduled-wakeup.module';
import { SessionRequestWorkerModule } from './sessions/session-request-worker.module';
import { WikiModule } from './wiki/wiki.module';
import { WikiChatModule } from './wiki/wiki-chat.module';
import { ManagedRunnerGateModule } from './managed-runners/managed-runner-gate';
import { ManagedRunnerModule } from './managed-runners/managed-runner.module';
import { FeishuModule } from './feishu/feishu.module';
import { FeishuActionsModule } from './feishu/feishu-actions.module';
import { EmailModule } from './email/email.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RealtimeModule,
    EventsModule,
    MetricsModule,
    HealthModule,
    QueueModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    SessionsModule,
    SessionTagsModule,
    SessionFoldersModule,
    TasksModule,
    TaskListsModule,
    LinkPreviewsModule,
    WatchesModule,
    OwnerRequestsModule,
    ProjectsModule,
    RunnersModule,
    RunnerApiModule,
    AttachmentsModule,
    SharedModule,
    ShareLinksModule,
    SessionGuestsModule,
    PushModule,
    ProvidersModule,
    // The provider/engine data migration, once per start, before the server listens (API server only).
    ProviderEngineMigrationModule,
    // Revision 29's deploy-time landing pass (§10.9), once per start, before the server listens.
    LandingObservationBackfillModule,
    OutcomeReconcilerHttpModule,
    WatchEvaluatorModule,
    WatchDeliveryModule,
    ScheduledWakeupModule,
    SessionRequestWorkerModule,
    WikiModule,
    // The wiki chat's door: its own module, as it makes sessions through SessionsService (wiki-chat.module.ts).
    WikiChatModule,
    ManagedRunnerGateModule,
    ManagedRunnerModule,
    // Each account's own Feishu (Lark) app, and the administrators' switch for them (docs/feishu-bot-design.md).
    FeishuModule,
    FeishuActionsModule,
    // Outgoing email: Admin → Email and the welcome-email outbox worker (docs/welcome-email-design.md).
    EmailModule,
  ],
  // Registered here rather than in main.ts (where WorkspaceAliasInterceptor is) because it needs
  // PrismaService injected, which only the DI container can provide.
  providers: [{ provide: APP_INTERCEPTOR, useClass: ClientVersionInterceptor }],
})
export class AppModule {}
