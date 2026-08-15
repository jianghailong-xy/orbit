import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { Runner } from '@prisma/client';
import { CreateTaskListDto, UpdateTaskListDto } from '../task-lists/dto';
import { TaskListsService } from '../task-lists/task-lists.service';
import {
  AddDependencyDto,
  CreateTaskCommentDto,
  CreateTaskDto,
  CreateTasksBatchDto,
  ProposeDagDto,
  UpdateTaskDto,
} from '../tasks/dto';
import { TasksService } from '../tasks/tasks.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The acting workspace, from either spelling of the header.
 *
 * Migration 0094 renamed Agent to Workspace and this controller's header with it, but the runner
 * still sends `X-Orbit-Agent-Id` — so every in-session write has been arriving unattributed and
 * silently recorded against the runner owner instead of the agent. Accepting both is what fixes
 * that for the binaries already deployed, which cannot be upgraded by this change; a runner that
 * sends the new name wins where both are present.
 */
function actingWorkspaceId(
  workspaceId: string | undefined,
  legacyAgentId: string | undefined,
): string | undefined {
  return workspaceId || legacyAgentId;
}

/**
 * Task/TaskList management for in-session workspaces, reached by the `orbit mcp` server
 * with the machine's runner token. Tenant scope is the runner's owner; work is
 * attributed to the acting workspace (passed via X-Orbit-Workspace-Id), validated to belong
 * to that owner. Mirrors TasksController but swaps JWT/user for runner-token/owner.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerTasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly taskLists: TaskListsService,
  ) {}

  @Post('tasks')
  async createTask(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: CreateTaskDto,
  ) {
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, actingWorkspaceId(workspaceId, legacyAgentId));
    return this.tasks.create(runner.ownerId, dto, creator, sessionId);
  }

  // Literal path, declared before 'tasks/:id' so the param route can't shadow it.
  @Post('tasks/batch-create')
  async createTasks(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: CreateTasksBatchDto,
  ) {
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, actingWorkspaceId(workspaceId, legacyAgentId));
    return this.tasks.createMany(runner.ownerId, dto, creator, sessionId);
  }

  /**
   * Filtered/paged when the caller asks (`status`, `listId`, `limit`), because the unfiltered
   * list is every task the owner ever created, description included — tens of megabytes for a
   * heavy account, which the CLI has to buffer whole before it can filter client-side. The
   * filtered form answers from the same page query the browser uses, so the rows carry no
   * description (that is what `task get` is for).
   *
   * A caller that passes nothing still gets the full list: runners older than this endpoint's
   * filters do their own filtering and must not silently see a truncated one.
   */
  @Get('tasks')
  async listTasks(
    @CurrentRunner() runner: Runner,
    @Query('status') status?: string,
    @Query('listId', PublicIdPipe) listId?: string,
    @Query('limit') limit?: string,
  ) {
    if (!status && !listId && !limit) return this.tasks.list(runner.ownerId);
    const page = await this.tasks.listPage(runner.ownerId, {
      status,
      listId,
      limit,
      counts: 'none',
    });
    return page.items;
  }

  @Get('tasks/:id')
  getTask(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.get(runner.ownerId, id);
  }

  @Get('tasks/:id/dependency-graph')
  getTaskDependencyGraph(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Query('maxDepth') maxDepth?: string,
    @Query('maxNodes') maxNodes?: string,
  ) {
    return this.tasks.dependencyGraph(runner.ownerId, id, { maxDepth, maxNodes });
  }

  @Patch('tasks/:id')
  updateTask(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(runner.ownerId, id, dto);
  }

  @Delete('tasks/:id')
  deleteTask(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.remove(runner.ownerId, id);
  }

  @Post('tasks/:id/execute')
  executeTask(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.execute(runner.ownerId, id);
  }

  @Post('tasks/:id/dependencies')
  addTaskDependency(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: AddDependencyDto,
  ) {
    return this.tasks.addDependency(runner.ownerId, id, dto.dependsOnTaskId);
  }

  @Delete('tasks/:id/dependencies/:dependsOnTaskId')
  removeTaskDependency(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Param('dependsOnTaskId', PublicIdPipe) dependsOnTaskId: string,
  ) {
    return this.tasks.removeDependency(runner.ownerId, id, dependsOnTaskId);
  }

  @Post('tasks/:id/comments')
  async addComment(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: CreateTaskCommentDto,
  ) {
    const author = await this.tasks.resolveAgentCreator(runner.ownerId, actingWorkspaceId(workspaceId, legacyAgentId));
    return this.tasks.addComment(runner.ownerId, id, dto, author);
  }

  @Get('task-lists')
  listLists(@CurrentRunner() runner: Runner) {
    return this.taskLists.list(runner.ownerId);
  }

  @Post('task-lists')
  createList(@CurrentRunner() runner: Runner, @Body() dto: CreateTaskListDto) {
    return this.taskLists.create(runner.ownerId, dto);
  }

  /**
   * One list's policy and progress. `summary`, not `get`: the detail read returns every task
   * with its dependency state, and the callers here — a foreman diagnosing a stall, a reference
   * being expanded into a prompt — need the shape of the list, not 500 rows of its contents.
   */
  @Get('task-lists/:id')
  getList(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.taskLists.summary(runner.ownerId, id);
  }

  /**
   * Change a list's dispatch policy from inside a session. Recorded as a revision attributed to
   * the acting workspace and the session it ran in, so a change made by an agent can be traced
   * back to the run that made it — and undone.
   *
   * Restoring a revision is deliberately NOT exposed here. An agent may change policy; putting it
   * back is the human's move, and that asymmetry is what makes handing an agent this write safe
   * to begin with.
   */
  @Patch('task-lists/:id')
  async updateList(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: UpdateTaskListDto,
  ) {
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, actingWorkspaceId(workspaceId, legacyAgentId));
    return this.taskLists.update(
      runner.ownerId,
      id,
      dto,
      creator ? { type: creator.type, id: creator.id, sessionId } : undefined,
    );
  }

  /**
   * What a batch create would do. Pure read — it writes nothing, and it is what fills the approval
   * card. Building a DAG is the most consequential thing an agent does here, and the ops alone
   * do not show it: fifty titles say nothing about how many runs start within the minute.
   */
  @Post('tasks/batch-preview')
  previewBatch(@CurrentRunner() runner: Runner, @Body() dto: CreateTasksBatchDto) {
    return this.tasks.previewCreateMany(runner.ownerId, dto);
  }

  /**
   * What a proposed batch of dependency edits would do. Pure read — it writes nothing, and it is
   * what fills the approval card the human decides on.
   */
  @Post('task-lists/:id/dag-preview')
  previewDag(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ProposeDagDto,
  ) {
    return this.tasks.previewDag(runner.ownerId, id, dto.ops);
  }

  /**
   * Apply that batch. Called only after the human allowed it, and re-validated here rather than
   * trusting the preview: an approval happens at human speed and the graph may have moved.
   */
  @Post('task-lists/:id/dag-apply')
  applyDag(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ProposeDagDto,
  ) {
    return this.tasks.applyDag(runner.ownerId, id, dto.ops);
  }

  /**
   * Delete a list. Its tasks survive — the FK detaches them (list_id -> null) rather than
   * cascading — so this discards the grouping and its policy revisions, not the work.
   */
  @Delete('task-lists/:id')
  deleteList(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.taskLists.remove(runner.ownerId, id);
  }
}
