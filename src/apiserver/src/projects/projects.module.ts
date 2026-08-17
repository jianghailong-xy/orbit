import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

// PrismaModule is @Global. SessionsModule is imported for the coordinator's one session create/end
// and never re-provided: SessionsService is a singleton with its own state, and a second instance
// from a duplicate `providers` entry is how the auto-run reconciler once ended up running twice a
// minute. QueueService still has no business here — a project dispatches none of its tasks.
@Module({
  imports: [SessionsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
