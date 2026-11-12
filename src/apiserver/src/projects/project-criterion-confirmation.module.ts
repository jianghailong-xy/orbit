import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { ProjectCriterionConfirmationController } from './project-criterion-confirmation.controller';
import { ProjectCriterionConfirmationService } from './project-criterion-confirmation.service';

/** Criteria met by confirmation (migration 0545). Imports TasksModule for the Agent check, which
 *  is dispatched as one of the project's tasks; imported, never re-provided (see TasksModule). */
@Module({
  imports: [SessionsModule, PushModule, TasksModule],
  controllers: [ProjectCriterionConfirmationController],
  providers: [ProjectCriterionConfirmationService],
  exports: [ProjectCriterionConfirmationService],
})
export class ProjectCriterionConfirmationModule {}
