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
import { RunnerSessionsController } from './runner-sessions.controller';
import { RunnerAgentsController } from './runner-agents.controller';
import { RunnerProvidersController } from './runner-providers.controller';
import { RunnerNotifyController } from './runner-notify.controller';
import { RunnerServiceTokensController } from './runner-service-tokens.controller';
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
  ],
  // RunnerSessionsController is listed last so its GET sessions/:id can't shadow
  // RunnerApiController's static sessions/claim | sessions/reclaim routes.
  controllers: [
    RunnerApiController,
    RunnerTasksController,
    RunnerTaskCompletionEvidenceController,
    RunnerServiceTokensController,
    RunnerSessionsController,
    RunnerAgentsController,
    RunnerProvidersController,
    RunnerNotifyController,
    RunnerProjectsController,
  ],
  providers: [
    RunnerAuthGuard,
    RunnerSessionAuthGuard,
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
  ],
})
export class RunnerApiModule {}
