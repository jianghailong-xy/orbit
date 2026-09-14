import { Body, Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { DecideOwnerConfirmationDto } from '../tasks/dto';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The owner-confirmation door, as an execution reaches it — which is to be refused.
 *
 * Every agent tool and CLI command talks to Orbit over this protocol, so this is where an agent that
 * tries to confirm an OWNER_CONFIRMED task arrives. It is a real route rather than a 404 so that the
 * answer is the rule itself: the same service, asked by a runner principal, refuses with
 * OWNER_CONFIRMATION_REQUIRES_ACCOUNT_OWNER and the action that does settle the task, before it
 * reads anything.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner/tasks/:taskId/owner-confirmation')
export class RunnerTaskOwnerConfirmationController {
  constructor(private readonly confirmations: TaskOwnerConfirmationService) {}

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
