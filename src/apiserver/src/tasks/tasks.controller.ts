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
  RunTaskDto,
  BatchStopDto,
  CreateTaskCommentDto,
  CreateTaskDto,
  CreateTasksBatchDto,
  ExpandDependencyGraphDto,
  RefreshDependencyGraphNodesDto,
  SignoffTaskDto,
  UpdateTaskDto,
} from './dto';
import { ProjectAttributionService } from '../projects/project-attribution.service';
import { TasksService } from './tasks.service';

@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly attribution: ProjectAttributionService,
  ) {}

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
    // Free text, never an id: no PublicIdPipe, and a label that happens to look like a public id
    // must survive as the string it is.
    @Query('labels') labels?: string | string[],
    @Query('q') q?: string,
    @Query('counts') counts?: string,
  ) {
    return this.tasks.listPage(user.userId, {
      cursor,
      limit,
      status,
      listId,
      assigneeId,
      labels,
      q,
      counts,
    });
  }

  // The tab badges and the progress bar, on their own. They are identical for every tab, so a
  // client holds them across tab changes instead of asking for them with each tab's first page.
  @Get('counts')
  taskCounts(
    @CurrentUser() user: AuthUser,
    @Query('listId', PublicIdPipe.allowing('none')) listId?: string,
    @Query('assigneeId', PublicIdPipe) assigneeId?: string,
    @Query('labels') labels?: string | string[],
  ) {
    return this.tasks.taskCounts(user.userId, { listId, assigneeId, labels });
  }

  // Above :id, like "page" and "labels" — none of these literals is a task uuid.
  @Get('active')
  activeTasks(
    @CurrentUser() user: AuthUser,
    @Query('listId', PublicIdPipe.allowing('none')) listId?: string,
  ) {
    return this.tasks.activeTasks(user.userId, { listId });
  }

  // Above :id for the same reason as "page" — "labels" is not a task uuid.
  @Get('labels')
  labelSummary(
    @CurrentUser() user: AuthUser,
    @Query('listId', PublicIdPipe.allowing('none')) listId?: string,
    @Query('assigneeId', PublicIdPipe) assigneeId?: string,
  ) {
    return this.tasks.labelSummary(user.userId, { listId, assigneeId });
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

  /**
   * Unit L7: where this work counts, who noticed it, which acceptance reads it, and what is being
   * asked or refused about it.
   *
   * A read of its own rather than more fields on `GET :id`, and not because the task page is large:
   * this one joins the project, its acceptance criteria, the crossing table and the open blockers,
   * and the task page is fetched on every navigation. A screen that only wants the title should not
   * pay for the boundary.
   *
   * Lives on the task and not under `/projects/:id/...`, unlike the other per-task project reads,
   * for the case it exists to make visible: a task filed under NO project has an attribution
   * boundary too, and it is the one most worth looking at.
   */
  @Get(':id/attribution')
  attributionOf(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.attribution.read(user.userId, id);
  }

  /** Lightweight list-row hydration for incremental `task.changed` events. Kept separate from
   * `GET :id`, whose comments/runs/dependency detail is intentionally much heavier. */
  @Get(':id/row')
  listRow(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.listRow(user.userId, id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(user.userId, id, dto);
  }

  @Post(':id/signoff')
  signoff(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: SignoffTaskDto,
  ) {
    return this.tasks.signoff(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.remove(user.userId, id);
  }

  // Declared before ':id/execute' so the literal path isn't shadowed by the param route.
  //
  // `dryRun` (unit L7) judges the plan and writes none of it — not even the question a declared
  // crossing would otherwise file — and returns where every item would land, every finding
  // including the warnings a refusal body drops, and how many rows the real call would add. Same
  // endpoint rather than a second one, because a preview served by a different route is a preview
  // that can disagree with the write.
  @Post('batch-create')
  batchCreate(@CurrentUser() user: AuthUser, @Body() dto: CreateTasksBatchDto) {
    return dto.dryRun
      ? this.tasks.previewPlan(user.userId, dto)
      : this.tasks.createMany(user.userId, dto);
  }

  @Post('batch-execute')
  batchExecute(@CurrentUser() user: AuthUser, @Body() dto: BatchExecuteDto) {
    return this.tasks.batchExecute(user.userId, dto.taskIds, dto.maxConcurrent, dto.triggerId);
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

  /**
   * Run Now. The body is optional and carries one field: `triggerId`, this press's identity, which
   * is what makes a retry of it the same request rather than a second run. A client that sends no
   * body at all — every build predating the field — behaves exactly as it did.
   */
  @Post(':id/execute')
  execute(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RunTaskDto,
  ) {
    return this.tasks.execute(user.userId, id, undefined, dto?.triggerId);
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
