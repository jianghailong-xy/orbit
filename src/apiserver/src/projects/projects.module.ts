import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ProjectsController } from './projects.controller';
import { ProjectAvailabilityReaperService } from './project-availability-reaper.service';
import { ProjectDecisionService } from './project-decision.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileService } from './project-reconcile.service';
import { ProjectTaskDispatcherService } from './project-task-dispatcher.service';
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
    ProjectEventsService,
    ProjectDecisionService,
    ProjectAuthorizationService,
    ProjectReconcileService,
    ProjectTaskDispatcherService,
    ProjectAvailabilityReaperService,
  ],
  exports: [
    ProjectsService,
    ProjectEventsService,
    ProjectDecisionService,
    ProjectAuthorizationService,
    ProjectReconcileService,
    ProjectTaskDispatcherService,
  ],
})
export class ProjectsModule {}
