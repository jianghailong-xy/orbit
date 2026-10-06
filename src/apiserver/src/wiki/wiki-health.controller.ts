import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { WikiHealth } from './wiki-health';
import { WikiRolloutGuard } from './wiki-rollout';

/**
 * A space's health, on the user door (contract `maintenance.health`, criterion 5): what the Wiki home's
 * status line reads — the space's entries, and where its maintenance run stands.
 *
 * A controller of its own rather than a route on `WikiController`, as `WikiArticlesController` is, so
 * the specs that stand that one up by hand construct it exactly as before. The owner's alone: another
 * account's space is the plain 404 every tenancy check answers. A read — nothing here writes.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiHealthController {
  constructor(private readonly health: WikiHealth) {}

  @PatScope('wiki:read')
  @Get('spaces/:id/health')
  read(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.health.read(user.userId, id);
  }
}
