import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { actingSession } from './wiki.controller';
import { WikiRunReads } from './wiki-run-reads';
import { WikiRolloutGuard } from './wiki-rollout';

/**
 * One run, on the user door (contract `reviewModes.run.read`): a changeset by its id — what its ops did,
 * counted, and whether Revert run… would take anything back — whatever of it still waits in Review.
 *
 * A controller of its own rather than a route on `WikiController`, as `WikiArticlesController` is, so
 * the specs that stand that one up by hand construct it exactly as before. The owner's alone: another
 * account's changeset is the plain 404, and a request carrying a session header is refused
 * WIKI_OWNER_CHANNEL_ONLY before anything is read.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@PatForbidden('OWNER_INTERACTIVE')
@Controller('wiki')
export class WikiRunsController {
  constructor(private readonly runs: WikiRunReads) {}

  @Get('changesets/:id')
  changeset(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.runs.changeset(user.userId, id, actingSession(request.headers));
  }
}
