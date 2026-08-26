import { Module } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorWakeService } from './coordinator-wake.service';

/**
 * The timer-free fact → judgment path, shared by ProjectsModule and the task write producer.
 *
 * Keeping this slice in its own module avoids importing every project service into TasksModule and
 * also guarantees that both doors use one wake/judgment instance rather than re-providing either.
 */
@Module({
  imports: [SessionsModule],
  providers: [
    CoordinatorWakeService,
    CompletionInputRouter,
    CoordinatorConvergenceService,
    CoordinatorJudgmentService,
  ],
  exports: [
    CoordinatorWakeService,
    CompletionInputRouter,
    CoordinatorConvergenceService,
    CoordinatorJudgmentService,
  ],
})
export class CoordinatorJudgmentModule {}
