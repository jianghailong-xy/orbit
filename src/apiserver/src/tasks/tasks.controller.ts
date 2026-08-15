import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import {
  AddDependencyDto,
  BatchAssignDto,
  BatchDeleteDto,
  BatchExecuteDto,
  BatchStopDto,
  CreateTaskCommentDto,
  CreateTaskDto,
  CreateTasksBatchDto,
  ExpandDependencyGraphDto,
  RefreshDependencyGraphNodesDto,
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

  // Kept above :id so Nest never interprets the literal "page" as a task UUID.
  @Get('page')
  listPage(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    // `none` is this filter's sentinel for "tasks in no list", not an id — and it is also valid
    // base62, so without the exemption it decodes to a uuid no list has.
    @Query('listId', PublicIdPipe.allowing('none')) listId?: string,
    @Query('assigneeId', PublicIdPipe) assigneeId?: string,
    @Query('q') q?: string,
    @Query('counts') counts?: string,
  ) {
    return this.tasks.listPage(user.userId, {
      cursor,
      limit,
      status,
      listId,
      assigneeId,
      q,
      counts,
    });
  }

  @Get(':id/dependency-graph')
  dependencyGraph(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('direction') direction?: string,
    @Query('maxDepth') maxDepth?: string,
    @Query('maxNodes') maxNodes?: string,
    @Query('pairUnary') pairUnary?: string,
  ) {
    return this.tasks.dependencyGraph(user.userId, id, {
      direction,
      maxDepth,
      maxNodes,
      pairUnary,
    });
  }

  @Post(':id/dependency-graph/expand')
  expandDependencyGraph(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ExpandDependencyGraphDto,
  ) {
    return this.tasks.expandDependencyGraph(user.userId, id, dto);
  }

  @Post(':id/dependency-graph/nodes')
  dependencyGraphNodes(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RefreshDependencyGraphNodesDto,
  ) {
    return this.tasks.dependencyGraphNodes(user.userId, id, dto.taskIds);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.remove(user.userId, id);
  }

  // Declared before ':id/execute' so the literal path isn't shadowed by the param route.
  @Post('batch-create')
  batchCreate(@CurrentUser() user: AuthUser, @Body() dto: CreateTasksBatchDto) {
    return this.tasks.createMany(user.userId, dto);
  }

  @Post('batch-execute')
  batchExecute(@CurrentUser() user: AuthUser, @Body() dto: BatchExecuteDto) {
    return this.tasks.batchExecute(user.userId, dto.taskIds, dto.maxConcurrent);
  }

  @Post('batch-stop')
  batchStop(@CurrentUser() user: AuthUser, @Body() dto: BatchStopDto) {
    return this.tasks.batchStop(user.userId, dto.taskIds);
  }

  @Post('batch-delete')
  batchDelete(@CurrentUser() user: AuthUser, @Body() dto: BatchDeleteDto) {
    return this.tasks.batchDelete(user.userId, dto.taskIds);
  }

  @Post('batch-assign')
  batchAssign(@CurrentUser() user: AuthUser, @Body() dto: BatchAssignDto) {
    return this.tasks.batchAssign(user.userId, dto.taskIds, dto.assigneeId);
  }

  @Post(':id/execute')
  execute(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.execute(user.userId, id);
  }

  @Post(':id/comments')
  addComment(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: CreateTaskCommentDto,
  ) {
    return this.tasks.addComment(user.userId, id, dto);
  }

  @Delete(':id/comments/:commentId')
  removeComment(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('commentId', PublicIdPipe) commentId: string,
  ) {
    return this.tasks.removeComment(user.userId, id, commentId);
  }

  @Post(':id/dependencies')
  addDependency(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: AddDependencyDto,
  ) {
    return this.tasks.addDependency(user.userId, id, dto.dependsOnTaskId);
  }

  @Delete(':id/dependencies/:dependsOnTaskId')
  removeDependency(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('dependsOnTaskId', PublicIdPipe) dependsOnTaskId: string,
  ) {
    return this.tasks.removeDependency(user.userId, id, dependsOnTaskId);
  }
}
