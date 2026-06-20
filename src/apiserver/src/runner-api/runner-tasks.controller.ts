import { Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { CreateTaskListDto } from '../task-lists/dto';
import { TaskListsService } from '../task-lists/task-lists.service';
import { CreateTaskCommentDto, CreateTaskDto, UpdateTaskDto } from '../tasks/dto';
import { TasksService } from '../tasks/tasks.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * Task/TaskList management for in-session agents, reached by the `orbit mcp` server
 * with the machine's runner token. Tenant scope is the runner's owner; work is
 * attributed to the acting agent (passed via X-Orbit-Agent-Id), validated to belong
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
    @Headers('x-orbit-agent-id') agentId: string | undefined,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: CreateTaskDto,
  ) {
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, agentId);
    return this.tasks.create(runner.ownerId, dto, creator, sessionId);
  }

  @Get('tasks')
  listTasks(@CurrentRunner() runner: Runner) {
    return this.tasks.list(runner.ownerId);
  }

  @Get('tasks/:id')
  getTask(@CurrentRunner() runner: Runner, @Param('id') id: string) {
    return this.tasks.get(runner.ownerId, id);
  }

  @Patch('tasks/:id')
  updateTask(@CurrentRunner() runner: Runner, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasks.update(runner.ownerId, id, dto);
  }

  @Post('tasks/:id/comments')
  async addComment(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-agent-id') agentId: string | undefined,
    @Param('id') id: string,
    @Body() dto: CreateTaskCommentDto,
  ) {
    const author = await this.tasks.resolveAgentCreator(runner.ownerId, agentId);
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
}
