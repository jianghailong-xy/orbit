import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { DecideTaskJudgmentDto } from './dto';
import { TaskJudgmentReviewService } from './task-judgment-review.service';

/** Human-only inbox/review surface. Runner sessions intentionally have no matching controller. */
@UseGuards(JwtAuthGuard)
@Controller('judgments')
export class TaskJudgmentReviewController {
  constructor(private readonly reviews: TaskJudgmentReviewService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('projectId', PublicIdPipe) projectId?: string,
    @Query('taskId', PublicIdPipe) taskId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviews.list(user.userId, { status, projectId, taskId, limit });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.reviews.get(user.userId, id);
  }

  @Post(':id/decision')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() input: DecideTaskJudgmentDto,
  ) {
    return this.reviews.decide(user.userId, id, input);
  }
}
