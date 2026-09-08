import { Module, forwardRef } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

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
 *
 * `TaskExceptionInputProducer` joins them for exactly that reason: it composes this module's
 * `CoordinatorConvergenceService` into the authorizer its facts may not be delivered without, and
 * the router the task write path already holds is what reaches it. `CriterionReadyProducer` is the
 * third of the same shape, and the third to be constructed nowhere else. `CriterionUnlandedProducer`
 * is the fourth: it answers a question about MERGE receipts rather than about task statuses, and it
 * is here for the same one reason all of them are — the convergence service its authorizer composes
 * is this module's provider, and merging is the one coordinator action that cannot be undone, so an
 * unbounded version of this fact is the most expensive one to have wired anywhere else.
 *
 * `WakeDispositionService` is here for the other half of that argument: it decides which of the
 * three terminals an authorized wake gets, and two of them are performed by this module's own
 * providers — `CoordinatorJudgmentService` opens a session, `CoordinatorDeliveryService` writes to
 * the conversation the project already has. That is the reason the router can ask the question
 * without holding the answer.
 *
 * `CoordinatorDeliveryService` is registered beside the judgment one rather than in SessionsModule
 * even though `SessionsService` is what it ultimately calls: what it decides is which wake reaches
 * a coordinator, which is this module's subject, and SessionsModule is imported here already.
 */
@Module({
  // `forwardRef` because SessionsModule now imports this one back: `MergeReceiptService` delivers
  // through `CompletionInputRouter` after a receipt commits, which is the other half of the edge
  // this module's producers are derived on. Both sides declare it; neither can be resolved first.
  imports: [forwardRef(() => SessionsModule)],
  providers: [
    CoordinatorWakeService,
    CompletionInputRouter,
    CoordinatorConvergenceService,
    CoordinatorJudgmentService,
    CoordinatorDeliveryService,
    ProjectTasksSettledProducer,
    TaskExceptionInputProducer,
    CriterionReadyProducer,
    CriterionUnlandedProducer,
    WakeDispositionService,
  ],
  exports: [
    CoordinatorWakeService,
    CompletionInputRouter,
    CoordinatorConvergenceService,
    CoordinatorJudgmentService,
    CoordinatorDeliveryService,
    ProjectTasksSettledProducer,
    TaskExceptionInputProducer,
    CriterionReadyProducer,
    CriterionUnlandedProducer,
    WakeDispositionService,
  ],
})
export class CoordinatorJudgmentModule {}
