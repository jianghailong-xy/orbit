import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionsModule } from '../sessions/sessions.module';
import { TaskListsService } from '../task-lists/task-lists.service';
import { TasksModule } from '../tasks/tasks.module';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerTasksController } from './runner-tasks.controller';
import { RunnerSessionsController } from './runner-sessions.controller';
import { RunnerAgentsController } from './runner-agents.controller';
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
import { AgentsService } from '../agents/agents.service';
import { PushModule } from '../push/push.module';

@Module({
  // TasksService is imported from TasksModule rather than re-provided here: a second
  // provider entry would give this module its own instance, and TasksService owns a
  // singleton-ish timer (the auto-run reconcile sweep), which would then run twice per
  // interval and dispatch every ready task twice. TaskListsService still only needs the
  // global PrismaService. PushModule provides PushService so the approval-create handler
  // can notify the session owner's iOS devices.
  imports: [SessionsModule, PushModule, TasksModule],
  // RunnerSessionsController is listed last so its GET sessions/:id can't shadow
  // RunnerApiController's static sessions/claim | sessions/reclaim routes.
  controllers: [
    RunnerApiController,
    RunnerTasksController,
    RunnerServiceTokensController,
    RunnerSessionsController,
    RunnerAgentsController,
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
    TaskListsService,
    AgentsService,
  ],
})
export class RunnerApiModule {}
