import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import {
  AddDependencyDto,
  BatchAssignDto,
  BatchExecuteDto,
  BatchStopDto,
  CreateTaskCommentDto,
  CreateTaskDto,
  UpdateTaskDto,
} from './dto';
import { TasksService } from './tasks.service';

@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.tasks.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tasks.list(user.userId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.remove(user.userId, id);
  }

  // Declared before ':id/execute' so the literal path isn't shadowed by the param route.
  @Post('batch-execute')
  batchExecute(@CurrentUser() user: AuthUser, @Body() dto: BatchExecuteDto) {
    return this.tasks.batchExecute(user.userId, dto.taskIds, dto.maxConcurrent);
  }

  @Post('batch-stop')
  batchStop(@CurrentUser() user: AuthUser, @Body() dto: BatchStopDto) {
    return this.tasks.batchStop(user.userId, dto.taskIds);
  }

  @Post('batch-assign')
  batchAssign(@CurrentUser() user: AuthUser, @Body() dto: BatchAssignDto) {
    return this.tasks.batchAssign(user.userId, dto.taskIds, dto.assigneeId);
  }

  @Post(':id/execute')
  execute(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.execute(user.userId, id);
  }

  @Post(':id/comments')
  addComment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateTaskCommentDto,
  ) {
    return this.tasks.addComment(user.userId, id, dto);
  }

  @Delete(':id/comments/:commentId')
  removeComment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ) {
    return this.tasks.removeComment(user.userId, id, commentId);
  }

  @Post(':id/dependencies')
  addDependency(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddDependencyDto,
  ) {
    return this.tasks.addDependency(user.userId, id, dto.dependsOnTaskId);
  }

  @Delete(':id/dependencies/:dependsOnTaskId')
  removeDependency(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('dependsOnTaskId') dependsOnTaskId: string,
  ) {
    return this.tasks.removeDependency(user.userId, id, dependsOnTaskId);
  }
}
