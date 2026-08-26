import { Module } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';

/**
 * The timer-free fact → judgment path, shared by ProjectsModule and the task write producer.
 *
 * Keeping this slice in its own module avoids importing every project service into TasksModule and
 * also guarantees that both doors use one wake/judgment instance rather than re-providing either.
 */
@Module({
  imports: [SessionsModule],
  providers: [CoordinatorWakeService, CoordinatorJudgmentService, ProjectTasksSettledProducer],
  exports: [CoordinatorWakeService, CoordinatorJudgmentService, ProjectTasksSettledProducer],
})
export class CoordinatorJudgmentModule {}
