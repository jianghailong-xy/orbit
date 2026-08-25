import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ProjectsController } from './projects.controller';
import { AttemptBudgetMeterService } from './attempt-budget-meter.service';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { SessionAttemptService } from './session-attempt.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectAttributionModule } from './project-attribution.module';
import { ProjectHandoffModule } from './project-handoff.module';
import { TaskCheckpointService } from './task-checkpoint.service';
import { ProjectsService } from './projects.service';

// PrismaModule is @Global. SessionsModule is imported for Project reads that join Sessions and is
// never re-provided: SessionsService is a singleton with its own state, and a second instance from
// a duplicate `providers` entry is how the auto-run reconciler once ended up running twice a
// minute.
@Module({
  imports: [SessionsModule, ProjectHandoffModule, ProjectAttributionModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ConvergenceLedgerService,
    CoordinatorWakeService,
    CoordinatorJudgmentService,
    CoordinatorConvergenceService,
    SessionAttemptService,
    AttemptBudgetMeterService,
    ProjectAcceptanceService,
    TaskCheckpointService,
  ],
  exports: [
    ProjectHandoffModule,
    ProjectAttributionModule,
    ProjectsService,
    ConvergenceLedgerService,
    // Exported so a producer of wake facts can live wherever the fact is committed rather than
    // having to be a Project service: unit T2 defines the ledger, T3/T5 hand facts to it.
    CoordinatorWakeService,
    // The composition of the two — claim the fact, open its one judgment session. A producer wants
    // THIS one; `CoordinatorWakeService` alone can win a key and leave nothing spending it.
    CoordinatorJudgmentService,
    // Exported for the same reason and to the same callers: a producer hands the fact to
    // `CoordinatorWakeService.claim`, and `CoordinatorConvergenceService.authorizeWake` is the
    // authorizer it hands along with it — composed LAST, after the cheaper refusals, because a
    // judgment recorded here charges the project's convergence budget.
    CoordinatorConvergenceService,
    // Exported so the RUNNER door guards attempts through the same instance the user door reads
    // them from. `[K3]` §3's refusals only mean anything at the door an agent actually knocks on.
    SessionAttemptService,
    // Exported for the same reason: unit T5 charges the budget where the spend is COMMITTED, which
    // is the runner's turn-complete, and that door is in another module.
    AttemptBudgetMeterService,
    ProjectAcceptanceService,
    TaskCheckpointService,
  ],
})
export class ProjectsModule {}
