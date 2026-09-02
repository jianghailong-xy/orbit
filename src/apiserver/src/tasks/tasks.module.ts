import { Module } from '@nestjs/common';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { ProjectAcceptanceModule } from '../projects/project-acceptance.module';
import { ProjectAttributionModule } from '../projects/project-attribution.module';
import { ProjectHandoffModule } from '../projects/project-handoff.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PushModule } from '../push/push.module';
import { TasksController } from './tasks.controller';
import { ReferenceExpansionService } from './reference-expansion';
import { TasksService } from './tasks.service';
import { TaskCompletionEvidenceController } from './task-completion-evidence.controller';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

@Module({
  imports: [
    SessionsModule,
    ProjectHandoffModule,
    ProjectAttributionModule,
    CoordinatorJudgmentModule,
    ProjectAcceptanceModule,
    PushModule,
  ],
  controllers: [
    TasksController,
    TaskCompletionEvidenceController,
  ],
  providers: [
    TasksService,
    ReferenceExpansionService,
    TaskCompletionEvidenceService,
  ],
  // Exported so RunnerApiModule can reuse this single instance. Providing TasksService
  // in a second module would construct a second one, and its onModuleInit would start a
  // second auto-run reconcile timer (every sweep, and every dispatch, would run twice).
  exports: [TasksService, ReferenceExpansionService, TaskCompletionEvidenceService],
})
export class TasksModule {}
