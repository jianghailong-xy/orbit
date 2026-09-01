import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { OutcomeSurfaceService } from './outcome-surface.service';

/**
 * `GET projects/:id/:surface` — the canonical obligation surface read — was removed with the
 * obligation algebra it projected. It is deliberately not replaced by a stub: there is no
 * projection behind it, and a route that answers an obligation question with an empty list is
 * worse than a route that is not there. Its callers are gone too (`orbit project obligations`,
 * MCP `project_obligations`), so the only reachable answer is 404.
 */
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

}
