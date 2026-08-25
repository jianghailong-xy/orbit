import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ProjectsController } from './projects.controller';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
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
    SessionAttemptService,
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
    // Exported so the RUNNER door guards attempts through the same instance the user door reads
    // them from. `[K3]` §3's refusals only mean anything at the door an agent actually knocks on.
    SessionAttemptService,
    ProjectAcceptanceService,
    TaskCheckpointService,
  ],
})
export class ProjectsModule {}
