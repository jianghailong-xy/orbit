import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { ConfirmPromotionDto } from './dto';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * The owner's card for merging a project branch into main
 * (`docs/project-integration-line-contract.md` §3.4 M-F3, §3.6).
 *
 * A controller of its own rather than four more routes on `ProjectsController`, for the reason that
 * controller's own comment gives at length: five specs stand a Nest module up around it and resolve
 * its dependencies by token, so a sixth constructor parameter is a controller Nest cannot build in
 * three `*.pg.spec.ts` files that `npm test` does not even run. Nothing here is shared with those,
 * so nothing here can break them.
 *
 * The session header is read only to refuse it. The app sends none; a request that carries one is
 * being made by an agent session, and M7 is that merging into main is the account owner's — whose
 * credential the agent is holding does not change who is deciding.
 */
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/promotions')
export class ProjectPromotionController {
  constructor(private readonly promotions: ProjectPromotionService) {}

  /** What this project is currently asking its owner to merge, or null when it is asking nothing. */
  @Get('current')
  current(@CurrentUser() user: AuthUser, @Param('projectId', PublicIdPipe) projectId: string) {
    return this.promotions.readCurrent(user.userId, projectId);
  }

  /**
   * The merges this project has already made, newest first — the record each one leaves in the
   * conversation it was made in, drawn where it happened (`ProjectPromotionReceipt`).
   *
   * A read of its own and not a widening of `current`, which is the candidate on offer: that row
   * moves on to the next one, and a receipt drawn from it describes a different merge every time
   * the branch is offered again.
   */
  @Get('merged')
  merged(@CurrentUser() user: AuthUser, @Param('projectId', PublicIdPipe) projectId: string) {
    return this.promotions.readMerged(user.userId, projectId);
  }

  /** M-T4: merge it. 409 when the candidate is not READY, which includes "its checks did not pass". */
  @Post(':promotionId/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('projectId', PublicIdPipe) projectId: string,
    @Param('promotionId', PublicIdPipe) promotionId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
    @Body() dto: ConfirmPromotionDto,
  ) {
    return this.promotions.confirm(
      { userId: user.userId, actingSessionId },
      projectId,
      promotionId,
      dto?.sourceSha ?? null,
    );
  }

  /** M-T5: not now. The branch is left exactly where it is, and the next landing offers it again. */
  @Post(':promotionId/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() user: AuthUser,
    @Param('projectId', PublicIdPipe) projectId: string,
    @Param('promotionId', PublicIdPipe) promotionId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
  ) {
    return this.promotions.decline({ userId: user.userId, actingSessionId }, projectId, promotionId);
  }

  /** M-T10: call back a confirmed merge, while its job has not reached the push. */
  @Post(':promotionId/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('projectId', PublicIdPipe) projectId: string,
    @Param('promotionId', PublicIdPipe) promotionId: string,
    @Headers('x-orbit-session-id') actingSessionId: string | undefined,
  ) {
    return this.promotions.cancel({ userId: user.userId, actingSessionId }, projectId, promotionId);
  }
}
