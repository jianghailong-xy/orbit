import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { CreatorType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import {
  DecideTaskEvidenceDto,
  ImportLegacyTaskCommentEvidenceDto,
  SubmitTaskCompletionEvidenceDto,
} from './dto';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

/** The user REST face of N10's evidence fact. It shares the service and response with runner/MCP. */
@UseGuards(JwtAuthGuard)
@Controller('tasks/:taskId/evidence')
export class TaskCompletionEvidenceController {
  constructor(private readonly evidence: TaskCompletionEvidenceService) {}

  @PatScope('tasks:write')
  @Post()
  submit(
    @CurrentUser() user: AuthUser,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: SubmitTaskCompletionEvidenceDto,
  ) {
    return this.evidence.submit(
      user.userId,
      taskId,
      { type: CreatorType.USER, id: user.userId },
      dto,
    );
  }

  @PatScope('tasks:write')
  @Post('legacy-import')
  importLegacyComment(
    @CurrentUser() user: AuthUser,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: ImportLegacyTaskCommentEvidenceDto,
  ) {
    return this.evidence.importLegacyComment(user.userId, taskId, {
      type: CreatorType.USER,
      id: user.userId,
    }, dto);
  }

  /**
   * The same decision door the runner protocol exposes, reached from the app.
   *
   * Not a second path, and deliberately not an owner's own: the caller has to NAME a deciding
   * session, and that session goes through the identical independence check, the identical
   * compare-and-set on the evidence revision and the identical criterion-text comparison. What the
   * browser supplies in the body, a runner supplies in a header; nothing else differs, which is
   * what makes the row an owner presses and the row a coordinator presses the same row.
   *
   * The one difference is who is asking, read the way the OWNER_CONFIRMED door reads it (this door,
   * and no session header): the account owner in the app may decide the owner card of a task in no
   * project that has no dispatching session from the run it is drawn in, the only conversation left
   * to draw it in (`evidence-review.ts#ownerDecidesInTheRun`).
   */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('decision')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: DecideTaskEvidenceDto,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
  ) {
    return this.evidence.decide(
      user.userId,
      taskId,
      { type: CreatorType.USER, id: user.userId },
      dto,
      { door: 'USER', userId: user.userId, actingSessionId },
    );
  }

  @PatScope('tasks:read')
  @Get()
  list(@CurrentUser() user: AuthUser, @Param('taskId', PublicIdPipe) taskId: string) {
    return this.evidence.list(user.userId, taskId);
  }
}
