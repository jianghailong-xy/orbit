import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ListEventsService } from './list-events.service';
import { TaskListPauseProjectorService } from './task-list-pause-projector.service';
import { TaskListsController } from './task-lists.controller';
import { TaskListsService } from './task-lists.service';

@Module({
  // Imported, never re-provided: SessionsService is a singleton with its own state, and a second
  // instance from a duplicate `providers` entry is how the auto-run reconciler once ended up
  // running twice a minute.
  imports: [SessionsModule],
  controllers: [TaskListsController],
  // The projector is provided here, beside the service whose decision it converges, and exported
  // for the two things that need the SAME instance: TaskListsService (the kick) and TasksModule
  // (the catch-up, on the reconcile timer — see its `onModuleInit`). A second provider entry
  // anywhere would be a second in-flight claim map and two sweeps of one list.
  providers: [TaskListsService, ListEventsService, TaskListPauseProjectorService],
  exports: [TaskListsService, ListEventsService, TaskListPauseProjectorService],
})
export class TaskListsModule {}
