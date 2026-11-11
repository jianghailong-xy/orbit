import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { WikiRepoProbeAnswer } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { BindWikiWorkspaceDto, WikiMaintenanceRunDto } from './dto';
import { probeWikiMaintenanceWorkspace } from './wiki-maintenance-probe';
import { runWikiMaintenanceNow, type WikiMaintenanceRunNow } from './wiki-maintenance-run';
import { WikiRolloutGuard } from './wiki-rollout';
import { actingSession } from './wiki.controller';
import { WikiRefusalError } from './wiki.service';

/**
 * The maintenance settings' two actions (docs/wiki-repo-tiers-design.md §7.3, contract `maintenance.probe` and
 * `maintenance.run`): the probe of a workspace the owner is about to choose, and `Check again and run now`.
 *
 * THE OWNER'S ALONE, as the settings they act for are: a request that carries a session header is refused
 * WIKI_OWNER_CHANNEL_ONLY, and a personal access token at the guard. A controller of its own, as the health is, so the
 * specs that stand `WikiController` up by hand construct it as before.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiMaintenanceController {
  constructor(private readonly prisma: PrismaService) {}

  /** Which tier the workspace's folder would be read on now, in the words the form draws (`WikiRepoProbeAnswer`). */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('spaces/:id/maintenance/probe')
  @HttpCode(HttpStatus.OK)
  probe(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: BindWikiWorkspaceDto,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ): Promise<WikiRepoProbeAnswer> {
    ownerOnly(request.headers);
    return probeWikiMaintenanceWorkspace(this.prisma, { ownerId: user.userId, spaceId: id, workspaceId: dto.workspaceId });
  }

  /** Make the space's maintenance run now: 201 with its job and run, 409 WIKI_MAINTENANCE_RUNNING or _DAILY_LIMIT. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('spaces/:id/maintenance/run')
  run(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiMaintenanceRunDto,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ): Promise<WikiMaintenanceRunNow> {
    ownerOnly(request.headers);
    return runWikiMaintenanceNow(this.prisma, { ownerId: user.userId, spaceId: id, acceptFolder: dto.acceptFolder === true });
  }
}

function ownerOnly(headers: Record<string, string | string[] | undefined>): void {
  if (actingSession(headers) === null) return;
  throw new WikiRefusalError({
    code: 'WIKI_OWNER_CHANNEL_ONLY',
    message: 'the maintenance settings are the account owner\'s to act on, through an owner channel with no acting session',
  });
}
