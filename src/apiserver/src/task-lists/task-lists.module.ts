import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { TaskListsController } from './task-lists.controller';
import { TaskListsService } from './task-lists.service';

@Module({
  // Imported, never re-provided: SessionsService is a singleton with its own state, and a second
  // instance from a duplicate `providers` entry is how the auto-run reconciler once ended up
  // running twice a minute.
  imports: [SessionsModule],
  controllers: [TaskListsController],
  providers: [TaskListsService],
  exports: [TaskListsService],
})
export class TaskListsModule {}
