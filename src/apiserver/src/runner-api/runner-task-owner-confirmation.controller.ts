import { Body, Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { DecideOwnerConfirmationDto } from '../tasks/dto';
import { OwnerConfirmationReviewService } from '../tasks/owner-confirmation-review.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The owner-confirmation surface, as an execution reaches it — one route for each side of it.
 *
 * `decide` is where an agent that tries to CONFIRM an OWNER_CONFIRMED task arrives, and is refused:
 * a real route rather than a 404 so that the answer is the rule itself — the same service, asked by
 * a runner principal, refuses with OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER and the action that
 * does settle the task, before it reads anything.
 *
 * `claim` is the other side, and the one route here an execution is meant to take: the run declares
 * that its task's work is finished, which is what makes the owner's card a statement by the run
 * rather than an inference from its silence. The session header is the declaration's subject — the
 * service takes it only from the task's own execution session, while that session is in a turn — and
 * it is a header rather than a body field for the reason every attribution here is: a declaration
 * whose author could be typed into the body says nothing.
 *
 * `review` and `return` are the reviewer's side (docs/owner-confirmation-review-contract.md §3.5,
 * §8): the session a request was handed to for review answers it with a structured record for the
 * owner, or sends it back to the run. The header is the reviewer here, checked against the session
 * the review row names, and the body is read field by field by the service — an unknown key is a
 * 400, not a field quietly dropped.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner/tasks/:taskId/owner-confirmation')
export class RunnerTaskOwnerConfirmationController {
  constructor(
    private readonly confirmations: TaskOwnerConfirmationService,
    private readonly reviews: OwnerConfirmationReviewService,
  ) {}

  @Post('claim')
  claim(
    @CurrentRunner() runner: Runner,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
  ) {
    return this.confirmations.claim(runner.ownerId, taskId, actingSessionId ?? null);
  }

  @Post('review')
  review(
    @CurrentRunner() runner: Runner,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.reviews.review(runner.ownerId, taskId, actingSessionId, body);
  }

  @Post('return')
  returnToRun(
    @CurrentRunner() runner: Runner,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.reviews.returnToRun(runner.ownerId, taskId, actingSessionId, body);
  }

  @Post()
  decide(
    @CurrentRunner() runner: Runner,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
    @Body() dto: DecideOwnerConfirmationDto,
  ) {
    return this.confirmations.decide(
      runner.ownerId,
      taskId,
      { door: 'RUNNER', userId: runner.ownerId, actingSessionId },
      dto,
    );
  }
}
