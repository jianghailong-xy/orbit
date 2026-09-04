import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

/**
 * The read behind the decision rail: what one session is being asked to decide, right now.
 *
 * Its own controller because the question is not about one task — it is "which of this account's
 * tasks is waiting", which no `tasks/:taskId/...` prefix can express. The deciding session is
 * required rather than optional: every row carries whether THAT session may answer it, and a queue
 * that did not know who was reading it could only report a question, never whether the reader is
 * allowed to settle it.
 */
@UseGuards(JwtAuthGuard)
@Controller('tasks/evidence-decisions')
export class PendingEvidenceJudgmentsController {
  constructor(private readonly evidence: TaskCompletionEvidenceService) {}

  @Get('pending')
  pending(
    @CurrentUser() user: AuthUser,
    @Query('decidingSessionId', PublicIdPipe) decidingSessionId: string | undefined,
  ) {
    if (!decidingSessionId) {
      throw new BadRequestException('decidingSessionId names the session these rows are read for');
    }
    return this.evidence.pending(user.userId, decidingSessionId);
  }
}
