import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [SessionsModule],
  controllers: [TasksController],
  providers: [TasksService],
  // Exported so RunnerApiModule can reuse this single instance. Providing TasksService
  // in a second module would construct a second one, and its onModuleInit would start a
  // second auto-run reconcile timer (every sweep, and every dispatch, would run twice).
  exports: [TasksService],
})
export class TasksModule {}
