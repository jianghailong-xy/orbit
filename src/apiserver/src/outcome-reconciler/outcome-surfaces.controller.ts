import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import {
  OutcomeSurfaceService,
  type BoundOutcomeDecisionInput,
} from './outcome-surface.service';

@UseGuards(JwtAuthGuard)
@Controller('outcomes')
export class OutcomeSurfacesController {
  constructor(private readonly surfaces: OutcomeSurfaceService) {}

  @Get('inbox')
  inbox(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.surfaces.humanInbox(
      user.userId,
      limit === undefined ? 100 : Number(limit),
    );
  }

  @Get('projects/:id/:surface')
  read(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('surface') surface: string,
  ) {
    return this.surfaces.readProjectSurface({
      tenantId: user.userId,
      projectId,
      surface: this.surfaces.parseSurface(surface),
      actor: 'OWNER',
    });
  }

  @Get('projects/:id/failure-coordination/:surface')
  readFailureCoordination(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) projectId: string,
    @Param('surface') surface: string,
  ) {
    return this.surfaces.readFailureProjectSurface(
      user.userId,
      projectId,
      this.surfaces.parseFailureSurface(surface),
    );
  }

  @Get('decisions/:requestId')
  decision(
    @CurrentUser() user: AuthUser,
    @Param('requestId', PublicIdPipe) requestId: string,
  ) {
    return this.surfaces.ownerDecisionView(user.userId, requestId);
  }

  @Post('decisions/:requestId')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('requestId', PublicIdPipe) requestId: string,
    @Body() input: BoundOutcomeDecisionInput,
  ) {
    return this.surfaces.decideOwnerRequest(user.userId, requestId, input);
  }

}
