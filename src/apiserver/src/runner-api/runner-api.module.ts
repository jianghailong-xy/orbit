import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectsModule } from '../projects/projects.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TaskListsModule } from '../task-lists/task-lists.module';
import { TasksModule } from '../tasks/tasks.module';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerProjectsController } from './runner-projects.controller';
import { RunnerTasksController } from './runner-tasks.controller';
import { RunnerTaskCompletionEvidenceController } from './runner-task-completion-evidence.controller';
import { RunnerTaskOwnerConfirmationController } from './runner-task-owner-confirmation.controller';
import { RunnerTaskProgressController } from './runner-task-progress.controller';
import { RunnerSessionsController } from './runner-sessions.controller';
import { RunnerAgentsController } from './runner-agents.controller';
import { RunnerProvidersController } from './runner-providers.controller';
import { RunnerNotifyController } from './runner-notify.controller';
import { RunnerServiceTokensController } from './runner-service-tokens.controller';
import { RunnerWatchesController } from './runner-watches.controller';
import { RunnerReleaseController } from './runner-release.controller';
import { RunnerLinkGatewayGuard, RunnerLinkTokenController } from './runner-link-token.controller';
import { RunnerLinkWelcomeController } from './runner-link-welcome.controller';
import { RunnerLinkModeController, RunnerLinkRequiredController } from './runner-link-required.controller';
import { RunnerLinkRequiredInterceptor, RunnerLinkSwitch } from './runner-link-required';
import { RunnerReleaseFeed } from './runner-release-feed';
import { RUNNER_LINK, runnerLinkFrom } from './runner-link-token';
import { RunnerSessionAuthGuard } from './runner-session-auth.guard';
import {
  createServiceTokenJwt,
  SERVICE_TOKEN_JWT,
  ServiceTokenAuthorizer,
} from './service-token.authorizer';
import {
  createRunnerOrchestrationJwt,
  RUNNER_ORCHESTRATION_JWT,
  RunnerOrchestrationAuthorizer,
} from './runner-orchestration-authorizer';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { PushModule } from '../push/push.module';
import { ProvidersModule } from '../providers/providers.module';
import { RunnerWriteProtocolInterceptor } from './runner-write-protocol';
import { IntegrationJobRelay } from './integration-job-relay';
import { WikiRepoOps } from '../wiki-worker/wiki-repo-ops';
import { OutcomeReconcilerModule } from '../outcome-reconciler/outcome-reconciler.module';
import { WatchesModule } from '../watches/watches.module';
import { WikiModule } from '../wiki/wiki.module';
import { RunnerWikiController } from './runner-wiki.controller';
import { AdminRoleGuard } from '../users/admin-role.guard';

@Module({
  // TasksService and TaskListsService are imported from their own modules rather than
  // re-provided here: a second provider entry gives this module its own instance, and that is
  // how the auto-run reconcile sweep once ran twice per interval and dispatched every ready
  // task twice. TaskListsService used to need nothing but the global PrismaService, which is
  // why it was listed as a provider — it now injects SessionsService for the list console, so
  // a duplicate would be two objects disagreeing about which session a list is steered from.
  // PushModule provides PushService so the approval-create handler can notify the session
  // owner's iOS devices, and RunnerNotifyController can send the agent's own.
  // ProjectsModule for the same single-instance reason as the rest: RunnerProjectsController reads
  // through the exported ProjectsService rather than re-providing it, so the runner door and the
  // user door answer from one object.
  imports: [
    SessionsModule,
    PushModule,
    TasksModule,
    TaskListsModule,
    ProvidersModule,
    ProjectsModule,
    OutcomeReconcilerModule,
    // RunnerWatchesController reads and writes through the one WatchesService the user door uses.
    WatchesModule,
    // And RunnerWikiController through the one WikiService the user door writes with: one entry point
    // underneath both doors is what makes "there is one write path" true rather than intended.
    WikiModule,
  ],
  // RunnerSessionsController is listed last so its GET sessions/:id can't shadow
  // RunnerApiController's static sessions/claim | sessions/reclaim routes.
  controllers: [
    RunnerApiController,
    RunnerTasksController,
    RunnerTaskCompletionEvidenceController,
    RunnerTaskOwnerConfirmationController,
    RunnerTaskProgressController,
    RunnerServiceTokensController,
    RunnerSessionsController,
    RunnerAgentsController,
    RunnerProvidersController,
    RunnerNotifyController,
    RunnerProjectsController,
    RunnerWatchesController,
    // Which runner release each runner is to run (runner-release.ts).
    RunnerReleaseController,
    RunnerWikiController,
    // The runner link's connection tokens and the gateway's revocation list (runner-link-token.ts).
    RunnerLinkTokenController,
    // What the link gateway's Welcome says of a connecting process's sessions and release (runner-link-welcome.ts).
    RunnerLinkWelcomeController,
    // RUNNER_LINK_REQUIRED, the cut-over switch: switched by an administrator, read by the link gateway
    // (runner-link-required.ts).
    RunnerLinkRequiredController,
    RunnerLinkModeController,
  ],
  providers: [
    RunnerAuthGuard,
    RunnerSessionAuthGuard,
    RunnerLinkGatewayGuard,
    RunnerWriteProtocolInterceptor,
    // The cut-over switch and RunnerApiController's interceptor that answers it (runner-link-required.ts).
    // AdminRoleGuard depends only on the global PrismaService; UsersModule does not export it.
    RunnerLinkSwitch,
    RunnerLinkRequiredInterceptor,
    AdminRoleGuard,
    {
      provide: RUNNER_LINK,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => runnerLinkFrom(config),
    },
    // What /dl publishes, for the release the runner link states (runner-release-feed.ts).
    {
      provide: RunnerReleaseFeed,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new RunnerReleaseFeed(config.get<string>('RUNNER_RELEASE_DL_URL')),
    },
    {
      provide: RUNNER_ORCHESTRATION_JWT,
      inject: [ConfigService],
      useFactory: createRunnerOrchestrationJwt,
    },
    RunnerOrchestrationAuthorizer,
    {
      provide: SERVICE_TOKEN_JWT,
      inject: [ConfigService],
      useFactory: createServiceTokenJwt,
    },
    ServiceTokenAuthorizer,
    WorkspacesService,
    IntegrationJobRelay,
    WikiRepoOps,
  ],
})
export class RunnerApiModule {}
