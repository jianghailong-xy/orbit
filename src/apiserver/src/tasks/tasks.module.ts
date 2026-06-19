import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [SessionsModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
