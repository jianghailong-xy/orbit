import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { ReportTaskProgressDto } from '../tasks/dto';
import { TaskProgressService } from '../tasks/task-progress.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * A Task's structured progress as an agent reaches it (docs/watch-contract.md §12.1): `orbit mcp`'s
 * task_progress_report and `orbit task progress`, with the runner credential.
 *
 * The same service as the user door, asked for the runner's owner. An agent reads and reports only its
 * owner's tasks, another owner's task is the service's 404, and every refusal is the service's own: 409
 * PROGRESS_REVISION_CONFLICT for a stale expectedRevision, 409 TASK_NOT_OPEN for a task with a
 * conclusion, 403 VERIFIER_WRITE_FROM_RUN_REFUSED for another run reporting a verifier's progress. A
 * read asks for no session, as task_get does not. A report names the session it comes from when it has
 * one, which a runner older than this door does not: that request reads as it always did.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner/tasks/:id/progress')
export class RunnerTaskProgressController {
  constructor(private readonly progress: TaskProgressService) {}

  @Get()
  get(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.progress.get(runner.ownerId, id);
  }

  /** Each field named replaces that field and `null` clears it; `expectedRevision` makes the report a compare-and-set. */
  @Post()
  @HttpCode(HttpStatus.OK)
  report(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ReportTaskProgressDto,
    @Headers('x-orbit-session-id') sessionId?: string,
  ) {
    return this.progress.report(runner.ownerId, id, dto, sessionId);
  }
}
