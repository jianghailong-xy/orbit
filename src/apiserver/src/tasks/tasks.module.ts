import { Module } from '@nestjs/common';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { ProjectAttributionModule } from '../projects/project-attribution.module';
import { ProjectHandoffModule } from '../projects/project-handoff.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PushModule } from '../push/push.module';
import { TaskListsModule } from '../task-lists/task-lists.module';
import { TasksController } from './tasks.controller';
import { ReferenceExpansionService } from './reference-expansion';
import { TasksService } from './tasks.service';
import { TaskCompletionEvidenceController } from './task-completion-evidence.controller';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { PendingEvidenceJudgmentsController } from './pending-evidence-judgments.controller';
import { TaskOwnerConfirmationController } from './task-owner-confirmation.controller';
import { TaskOwnerConfirmationService } from './task-owner-confirmation.service';
import { TaskProgressController } from './task-progress.controller';
import { TaskProgressService } from './task-progress.service';

@Module({
  imports: [
    SessionsModule,
    ProjectHandoffModule,
    ProjectAttributionModule,
    CoordinatorJudgmentModule,
    PushModule,
    // For the pause projector's catch-up sweep, which rides this module's existing reconcile
    // timer: a paused list's tasks become dispatchable work, and the sweep that dispatches them
    // is this one. Imported, never re-provided — a second instance would be a second in-flight
    // claim map, and this module already carries the warning about what a duplicated provider
    // does to a sweep (see the `exports` note below).
    TaskListsModule,
  ],
  controllers: [
    TasksController,
    PendingEvidenceJudgmentsController,
    TaskCompletionEvidenceController,
    TaskOwnerConfirmationController,
    TaskProgressController,
  ],
  providers: [
    TasksService,
    ReferenceExpansionService,
    TaskCompletionEvidenceService,
    TaskOwnerConfirmationService,
    TaskProgressService,
  ],
  // Exported so RunnerApiModule can reuse this single instance. Providing TasksService
  // in a second module would construct a second one, and its onModuleInit would start a
  // second auto-run reconcile timer (every sweep, and every dispatch, would run twice).
  exports: [
    TasksService,
    ReferenceExpansionService,
    TaskCompletionEvidenceService,
    TaskOwnerConfirmationService,
    TaskProgressService,
  ],
})
export class TasksModule {}
