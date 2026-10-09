import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { WikiJobReads } from './wiki-job-reads';
import { WikiRolloutGuard } from './wiki-rollout';

/**
 * A space's server runs, on the user door (contract `jobs.read`, P9): what Activity's Runs card and a run's page
 * read — each run's step, its calls and where they wait. A controller of its own, as `WikiHealthController` is. The
 * owner's alone: another account's space is the plain 404 every tenancy check answers. A read — nothing here writes.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiJobsController {
  constructor(private readonly jobs: WikiJobReads) {}

  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/jobs')
  read(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.jobs.read(user.userId, id);
  }
}
