import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { OutcomeSurfaceService } from './outcome-surface.service';

/**
 * `GET projects/:id/:surface` — the canonical obligation surface read — was removed with the
 * obligation algebra it projected, and `GET projects/:id/failure-coordination/:surface` went the
 * same way with migration 0226. Neither is replaced by a stub: there is no projection behind
 * either, and a route that answers an obligation question with an empty list is worse than a route
 * that is not there. Their callers are gone too (`orbit project obligations`, MCP
 * `project_obligations`, the Web failure card), so the only reachable answer is 404.
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

}
