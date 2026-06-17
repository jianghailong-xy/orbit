import { Module } from '@nestjs/common';
import { TaskListsController } from './task-lists.controller';
import { TaskListsService } from './task-lists.service';

@Module({
  controllers: [TaskListsController],
  providers: [TaskListsService],
})
export class TaskListsModule {}
