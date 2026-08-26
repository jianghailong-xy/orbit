import { Module } from '@nestjs/common';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { ProjectAttributionModule } from '../projects/project-attribution.module';
import { ProjectHandoffModule } from '../projects/project-handoff.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PushModule } from '../push/push.module';
import { TasksController } from './tasks.controller';
import { ReferenceExpansionService } from './reference-expansion';
import { TasksService } from './tasks.service';
import { TaskCompletionEvidenceController } from './task-completion-evidence.controller';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TaskJudgmentRequestController } from './task-judgment-request.controller';
import { TaskJudgmentReviewController } from './task-judgment-review.controller';
import { TaskJudgmentReviewService } from './task-judgment-review.service';

@Module({
  imports: [
    SessionsModule,
    ProjectHandoffModule,
    ProjectAttributionModule,
    CoordinatorJudgmentModule,
    PushModule,
  ],
  controllers: [
    TasksController,
    TaskCompletionEvidenceController,
    TaskJudgmentRequestController,
    TaskJudgmentReviewController,
  ],
  providers: [
    TasksService,
    ReferenceExpansionService,
    TaskCompletionEvidenceService,
    TaskJudgmentReviewService,
  ],
  // Exported so RunnerApiModule can reuse this single instance. Providing TasksService
  // in a second module would construct a second one, and its onModuleInit would start a
  // second auto-run reconcile timer (every sweep, and every dispatch, would run twice).
  exports: [TasksService, ReferenceExpansionService, TaskCompletionEvidenceService],
})
export class TasksModule {}
