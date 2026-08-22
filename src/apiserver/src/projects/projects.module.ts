import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ProjectsController } from './projects.controller';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectAvailabilityReaperService } from './project-availability-reaper.service';
import { ProjectDecisionService } from './project-decision.service';
import { ProjectDispatchPassService } from './project-dispatch-pass.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectCoordinatorSessionService } from './project-coordinator-session.service';
import { ProjectCoordinatorTurnService } from './project-coordinator-turn.service';
import { ProjectReconcileService } from './project-reconcile.service';
import { ProjectTaskDispatcherService } from './project-task-dispatcher.service';
import { ProjectVerificationVerdictService } from './project-verification-verdict.service';
import { ProjectsService } from './projects.service';

// PrismaModule is @Global. SessionsModule is imported for the coordinator's one session create/end
// and never re-provided: SessionsService is a singleton with its own state, and a second instance
// from a duplicate `providers` entry is how the auto-run reconciler once ended up running twice a
// minute. The task dispatcher uses the global queue only to wake an already committed Session.
@Module({
  imports: [SessionsModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ProjectAcceptanceService,
    ProjectEventsService,
    ProjectDecisionService,
    ProjectAuthorizationService,
    ProjectReconcileService,
    ProjectCoordinatorSessionService,
    ProjectCoordinatorTurnService,
    ProjectTaskDispatcherService,
    ProjectDispatchPassService,
    ProjectVerificationVerdictService,
    ProjectAvailabilityReaperService,
  ],
  exports: [
    ProjectsService,
    ProjectAcceptanceService,
    ProjectEventsService,
    ProjectDecisionService,
    ProjectAuthorizationService,
    ProjectReconcileService,
    ProjectCoordinatorSessionService,
    ProjectCoordinatorTurnService,
    ProjectTaskDispatcherService,
    ProjectDispatchPassService,
    ProjectVerificationVerdictService,
  ],
})
export class ProjectsModule {}
