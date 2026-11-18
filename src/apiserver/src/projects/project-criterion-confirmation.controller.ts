import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { ConfirmCriterionDto, StartCriterionCheckDto } from './dto';
import { ProjectCriterionConfirmationService } from './project-criterion-confirmation.service';

/**
 * The account owner's doors on a CONFIRMATION criterion (migration 0545): confirm it holds, take
 * that back, or start an Agent check of it. The coordinator's are on the runner door
 * (`runner-criterion-confirmation.controller.ts`).
 */
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectCriterionConfirmationController {
  constructor(private readonly confirmations: ProjectCriterionConfirmationService) {}

  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/criteria/:criterionId/confirmations')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('criterionId', PublicIdPipe) criterionId: string,
    @Body() dto: ConfirmCriterionDto,
  ) {
    return this.confirmations.confirm(user.userId, id, criterionId, { kind: 'OWNER' }, dto);
  }

  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/criteria/:criterionId/confirmations/withdraw')
  @HttpCode(200)
  withdraw(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('criterionId', PublicIdPipe) criterionId: string,
  ) {
    return this.confirmations.withdraw(user.userId, id, criterionId, { kind: 'OWNER' });
  }

  @PatScope('projects:write', { workspaceConfinable: false })
  @Post(':id/criteria/:criterionId/checks')
  startCheck(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('criterionId', PublicIdPipe) criterionId: string,
    @Body() dto: StartCriterionCheckDto,
  ) {
    return this.confirmations.startCheck(user.userId, id, criterionId, { kind: 'OWNER' }, dto);
  }
}
