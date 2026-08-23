import { Module } from '@nestjs/common';
import { ProjectHandoffModule } from '../projects/project-handoff.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksController } from './tasks.controller';
import { ReferenceExpansionService } from './reference-expansion';
import { TasksService } from './tasks.service';

@Module({
  imports: [SessionsModule, ProjectHandoffModule],
  controllers: [TasksController],
  providers: [TasksService, ReferenceExpansionService],
  // Exported so RunnerApiModule can reuse this single instance. Providing TasksService
  // in a second module would construct a second one, and its onModuleInit would start a
  // second auto-run reconcile timer (every sweep, and every dispatch, would run twice).
  exports: [TasksService, ReferenceExpansionService],
})
export class TasksModule {}
