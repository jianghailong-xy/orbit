import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

/** Read-only user surface for the durable questions later inbox/delivery work consumes. */
@UseGuards(JwtAuthGuard)
@Controller('tasks/:taskId/judgment-requests')
export class TaskJudgmentRequestController {
  constructor(private readonly evidence: TaskCompletionEvidenceService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('taskId', PublicIdPipe) taskId: string) {
    return this.evidence.listRequests(user.userId, taskId);
  }
}
