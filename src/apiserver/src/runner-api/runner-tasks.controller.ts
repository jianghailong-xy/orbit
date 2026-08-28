import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
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
  RunTaskDto,
  SignoffTaskDto,
  UpdateTaskDto,
} from '../tasks/dto';
import { ProjectAttributionService } from '../projects/project-attribution.service';
import { TasksService } from '../tasks/tasks.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import {
  RunnerWriteProtocolInterceptor,
  translateLegacyRunnerCompletionDeclaration,
} from './runner-write-protocol';

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
@UseInterceptors(RunnerWriteProtocolInterceptor)
@Controller('runner')
export class RunnerTasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly taskLists: TaskListsService,
    private readonly attribution: ProjectAttributionService,
  ) {}

  @Post('tasks')
  async createTask(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: CreateTaskDto,
  ) {
    RunnerTasksController.refuseImplicitHumanSignoff(dto);
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, actingWorkspaceId(workspaceId, legacyAgentId));
    return this.tasks.create(runner.ownerId, dto, creator, sessionId);
  }

  // Literal path, declared before 'tasks/:id' so the param route can't shadow it.
  //
  // `dryRun` (unit L7) judges the plan and writes none of it — not even the question a declared
  // crossing would otherwise file — and answers with where every item WOULD land: project id,
  // title, status and acceptance epoch, plus every finding including the warnings a refusal body
  // leaves out. Same route rather than a second one, because a preview served somewhere else is a
  // preview that can disagree with the write.
  @Post('tasks/batch-create')
  async createTasks(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: CreateTasksBatchDto,
  ) {
    RunnerTasksController.refuseImplicitHumanSignoffBatch(dto);
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, actingWorkspaceId(workspaceId, legacyAgentId));
    return dto.dryRun
      ? this.tasks.previewPlan(runner.ownerId, dto, creator, sessionId)
      : this.tasks.createMany(runner.ownerId, dto, creator, sessionId);
  }

  /**
   * Filtered/paged when the caller asks (`status`, `listId`, `projectId`, `limit`), because the
   * unfiltered list is every task the owner ever created, description included — tens of megabytes
   * for a heavy account, which the CLI has to buffer whole before it can filter client-side. The
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
    // Appended rather than grouped with the other filters: these parameters are bound by name at
    // runtime, but the controller's own tests call the method positionally, so inserting one in
    // the middle silently reassigns every argument after it.
    @Query('labels') labels?: string | string[],
    @Query('projectId', PublicIdPipe) projectId?: string,
  ) {
    // `labels` joins the other filters in this test, not just in the call below: the unfiltered
    // branch answers from tasks.list, which has no label filter, so leaving it out would make a
    // label-only request return every task while looking like it had filtered. `projectId` is in
    // for the identical reason — tasks.list has no project filter either, so a project-only
    // request routed there would answer with every task the owner has and read as "this project
    // is the whole account".
    if (!status && !listId && !limit && !labels && !projectId) {
      return this.tasks.list(runner.ownerId);
    }
    const page = await this.tasks.listPage(runner.ownerId, {
      status,
      listId,
      projectId,
      labels,
      limit,
      counts: 'none',
    });
    return page.items;
  }

  /**
   * Every label in scope with its status breakdown — the question labels exist to answer, and
   * the one a per-label loop answers 110 times. Above `tasks/:id` so "labels" is never read as
   * a task id.
   */
  @Get('tasks/labels')
  labelSummary(
    @CurrentRunner() runner: Runner,
    @Query('listId', PublicIdPipe.allowing('none')) listId?: string,
  ) {
    return this.tasks.labelSummary(runner.ownerId, { listId });
  }

  /**
   * One cursor page of tasks, newest first, together with the cursor for the next one.
   *
   * `GET tasks` above answers with a single bounded page and no way to ask for the rest, so its
   * answer on a large account is silently "the newest N" — enumerating one (to diff it against
   * something else, say) is impossible through it at any limit. This returns the page envelope
   * rather than a bare array precisely so the caller can tell whether it has reached the end.
   *
   * Declared above `tasks/:id` so Nest never reads the literal "page" as a task id.
   */
  @Get('tasks/page')
  listTaskPage(
    @CurrentRunner() runner: Runner,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('listId', PublicIdPipe) listId?: string,
    @Query('limit') limit?: string,
    @Query('labels') labels?: string | string[],
    // Appended for the reason `listTasks` above records: positional callers in the specs.
    @Query('projectId', PublicIdPipe) projectId?: string,
  ) {
    return this.tasks.listPage(runner.ownerId, {
      cursor,
      status,
      listId,
      projectId,
      labels,
      limit,
      // The tallies describe the scope, not the page, so re-deriving them once per page is
      // pure waste — and a caller walking every page never reads them.
      counts: 'none',
    });
  }

  /**
   * Unit L7: where this work counts, who noticed it, which acceptance criteria cite it, what is
   * being asked about it and what is stopping it.
   *
   * The read a coordinator most needs before it writes anywhere, and the one it could not make:
   * a task's project was an id, "where this was noticed" was four columns nothing read back, and
   * whether a PASS still counted was a comparison nobody outside the server could perform.
   *
   * Declared before `tasks/:id` for the reason every literal here is.
   */
  @Get('tasks/:id/attribution')
  getTaskAttribution(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.attribution.read(runner.ownerId, id);
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
    // The run this edit is being made from. Sent by the runner on every agent-side task write,
    // and read for decisions that turn on WHO is writing, including the independent-verification
    // rule (§13.2). Direct DONE is refused for every actor by `task-self-done-boundary.spec.ts`;
    // carrying identity still makes the refusal attributable. A header rather than a body field
    // because it is the caller's identity, not part of the edit — nothing an agent writes should
    // be able to claim it came from a different run.
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(runner.ownerId, id, dto, sessionId);
  }

  /**
   * Headless `orbit task signoff` is the owner's CLI door. An in-session MCP call carries the
   * acting Session header and is refused by TasksService: an agent cannot turn itself into the
   * human named by a HUMAN_SIGNOFF event merely by calling the human endpoint.
   */
  @Post('tasks/:id/signoff')
  signoffTask(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: SignoffTaskDto,
  ) {
    return this.tasks.signoff(runner.ownerId, id, dto, sessionId);
  }

  @Delete('tasks/:id')
  deleteTask(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.tasks.remove(runner.ownerId, id);
  }

  /**
   * `task_start`, from the MCP tool and from `orbit task start`. The body carries `triggerId` —
   * the id of THIS tool invocation, which the runner reuses across every transport retry of it, so
   * a call whose answer was lost is the same request rather than a second run. Optional, because a
   * runner predating the field sends no body.
   */
  @Post('tasks/:id/execute')
  executeTask(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RunTaskDto,
  ) {
    return this.tasks.execute(runner.ownerId, id, undefined, dto?.triggerId);
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
    RunnerTasksController.refuseImplicitHumanSignoffBatch(dto);
    return this.tasks.previewCreateMany(runner.ownerId, dto);
  }

  /**
   * The canonical task DTO keeps omission as the legacy HUMAN_SIGNOFF spelling so old JWT/user
   * clients and stored callers remain compatible. That is unsafe at the runner boundary: a stale
   * agent client that forgets one field would silently manufacture a human obligation.
   *
   * Do not infer the criterion from another field here. Apart from making the contract harder to
   * audit, that exception lets a retry collide with an older same-turn HUMAN_SIGNOFF winner whose
   * frozen idempotency key predates those fields. HUMAN_SIGNOFF remains available, but an agent
   * has to say it explicitly, just like either non-human peer.
   */
  private static refuseImplicitHumanSignoff(dto: {
    completionCriterion?: string | null;
    acceptanceCommand?: string | null;
    acceptanceExpectedExitCode?: number | null;
    completionPolicy?: string | null;
    verifiesTaskId?: string | null;
  }, itemIndex?: number): void {
    translateLegacyRunnerCompletionDeclaration(dto, itemIndex);
  }

  private static refuseImplicitHumanSignoffBatch(dto: CreateTasksBatchDto): void {
    dto.tasks.forEach((item, index) => RunnerTasksController.refuseImplicitHumanSignoff(item, index));
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
