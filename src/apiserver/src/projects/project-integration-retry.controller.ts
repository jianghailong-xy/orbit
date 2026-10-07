import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { RetryIntegrationDto, SkipMergeCheckAsOwnerDto } from './dto';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * The account owner's doors for rerunning a failed integration.
 *
 * This is deliberately a separate controller: ProjectsController is constructed by a number of
 * hand-written specs, and adding a dependency there makes those unrelated specs fail before they
 * can exercise their own route. Both routes use the same service decisions as the runner's
 * coordinator doors; the service records this press as a USER request.
 */
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectIntegrationRetryController {
  constructor(private readonly openItems: ProjectOpenItemService) {}

  /** Rerun the next LAND_TASK generation for a failed task landing. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/tasks/:taskId/integration/retry')
  @HttpCode(200)
  retryIntegration(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: RetryIntegrationDto,
  ) {
    return this.openItems.retryIntegrationAsOwner(user.userId, projectId, taskId, dto);
  }

  /**
   * Queue one landing again with its merge check NOT RUN (§2.4 J-S5).
   *
   * The account owner's own act, and the reason it needs no card: a skip is approved by them, and
   * asking them to answer their own question is not a gate. Every other rule of the door is the
   * service's own and is the same one the coordinator's card-gated route meets.
   */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/tasks/:taskId/integration/skip-merge-check')
  @HttpCode(200)
  skipIntegrationMergeCheck(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: SkipMergeCheckAsOwnerDto,
  ) {
    return this.openItems.skipIntegrationMergeCheckAsOwner(user.userId, projectId, taskId, dto);
  }

  /** Rerun a blocked candidate's failed check, leaving its merge decision untouched. */
  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/promotions/:promotionId/integration/retry')
  @HttpCode(200)
  retryPromotionCheck(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('promotionId', PublicIdPipe) promotionId: string,
    @Body() dto: RetryIntegrationDto,
  ) {
    return this.openItems.retryPromotionCheckAsOwner(user.userId, projectId, promotionId, dto);
  }
}
