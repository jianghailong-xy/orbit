import { Module } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';

/**
 * The clock-independent fact → judgment reducer, shared by synchronous producers and the
 * separately supervised persistent delivery worker. Time may schedule a retry; it cannot become
 * the fact, the judgment or the resolution.
 *
 * Keeping this slice in its own module avoids importing every project service into TasksModule and
 * also guarantees that both doors use one wake/judgment instance rather than re-providing either.
 *
 * Unit T7 is registered here rather than in TasksModule for the same reason: its two collaborators
 * (`CoordinatorJudgmentService`, `CoordinatorConvergenceService`) are this module's own providers,
 * and a producer provided where they are not visible is a producer nobody can construct. Exported
 * so the task write paths that must deliver AFTER their commit — TasksModule directly, the runner
 * door through ProjectsModule's re-export — reach the one instance rather than making a second.
 */
@Module({
  imports: [SessionsModule],
  providers: [
    CoordinatorWakeService,
    CompletionInputRouter,
    CoordinatorConvergenceService,
    CoordinatorJudgmentService,
    ProjectTasksSettledProducer,
  ],
  exports: [
    CoordinatorWakeService,
    CompletionInputRouter,
    CoordinatorConvergenceService,
    CoordinatorJudgmentService,
    ProjectTasksSettledProducer,
  ],
})
export class CoordinatorJudgmentModule {}
