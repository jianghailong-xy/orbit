import { BadRequestException, Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { CreatorType, Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { DecideRunnerTaskEvidenceDto, SubmitRunnerTaskCompletionEvidenceDto } from '../tasks/dto';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TasksService } from '../tasks/tasks.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/** The authenticated runner face used by both the task CLI and MCP tools. */
@UseGuards(RunnerAuthGuard)
@Controller('runner/tasks/:taskId/evidence')
export class RunnerTaskCompletionEvidenceController {
  constructor(
    private readonly evidence: TaskCompletionEvidenceService,
    private readonly tasks: TasksService,
  ) {}

  @Post()
  async submit(
    @CurrentRunner() runner: Runner,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') sourceSessionId: string | undefined,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Body() dto: SubmitRunnerTaskCompletionEvidenceDto,
  ) {
    if (!sourceSessionId) {
      throw new BadRequestException('x-orbit-session-id is required to submit completion evidence');
    }
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, workspaceId || legacyAgentId);
    return this.evidence.submit(
      runner.ownerId,
      taskId,
      creator ?? { type: CreatorType.USER, id: runner.ownerId },
      { ...dto, sourceSessionId },
    );
  }

  /**
   * The decision door, and deliberately only here.
   *
   * There is no user REST twin the way `submit` has one: a decision is one INDEPENDENT SESSION's
   * judgment, and a door with no session to check independence against could not make the check
   * this criterion exists for. The account owner reaches it the same way anything else does — from
   * a session.
   */
  @Post('decision')
  async decide(
    @CurrentRunner() runner: Runner,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') decidingSessionId: string | undefined,
    @Headers('x-orbit-workspace-id') workspaceId: string | undefined,
    @Headers('x-orbit-agent-id') legacyAgentId: string | undefined,
    @Body() dto: DecideRunnerTaskEvidenceDto,
  ) {
    if (!decidingSessionId) {
      throw new BadRequestException('x-orbit-session-id is required to decide completion evidence');
    }
    const creator = await this.tasks.resolveAgentCreator(runner.ownerId, workspaceId || legacyAgentId);
    return this.evidence.decide(
      runner.ownerId,
      taskId,
      creator ?? { type: CreatorType.USER, id: runner.ownerId },
      { ...dto, decidingSessionId },
    );
  }

  @Get()
  list(@CurrentRunner() runner: Runner, @Param('taskId', PublicIdPipe) taskId: string) {
    return this.evidence.list(runner.ownerId, taskId);
  }
}
