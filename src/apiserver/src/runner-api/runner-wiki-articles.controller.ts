import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiArticles } from '../wiki/wiki-articles';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import type { WikiPrincipal } from '../wiki/wiki.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The articles, on the runner door (contracts/wiki.contract.json `articles.routes`,
 * `agentSurface.doors.runner.maintenanceRoutes`): what `orbit wiki articles` asks — which topics'
 * entries changed, one topic's entries, and the write of its articles.
 *
 * ONLY A MAINTENANCE RUN OF THE SPACE. The calling session (`X-Orbit-Session-Id`, one this runner
 * hosts for its owner) is the principal, and `WikiArticles.assertWriter` asks it the one test
 * criterion 2 exported (`isWikiMaintenanceSession`): any other session of the owner is refused
 * WIKI_NOT_MAINTENANCE_SESSION, a headless call 400, and another owner's space is the plain 404. For an
 * account the executor switch gives the server, the maintenance run is refused too, WIKI_SERVER_EXECUTES:
 * the wiki worker writes those articles (contract `articles.serverExecution`).
 *
 * A controller of its own beside the maintenance one, so that neither injects anything it did not.
 */
@UseGuards(RunnerAuthGuard, WikiRolloutGuard)
@Controller('runner/wiki')
export class RunnerWikiArticlesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly articles: WikiArticles,
  ) {}

  /** Which topics need their articles written; a space with no topic is given the default ones first. */
  @Post('spaces/:id/article-plan')
  @HttpCode(HttpStatus.OK)
  async plan(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.articles.plan(await this.maintainer(runner, callingSessionId), id);
  }

  /** One topic's entries, best supported first, and the fingerprint a write must name. */
  @Get('spaces/:id/articles/:slug/input')
  async input(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('slug') slug: string,
  ) {
    return this.articles.input(await this.maintainer(runner, callingSessionId), id, slug);
  }

  /** One topic's articles, validated against its entries and stored in place of what it had. */
  @Post('spaces/:id/articles/:slug')
  @HttpCode(HttpStatus.OK)
  async write(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.articles.write(await this.maintainer(runner, callingSessionId), id, slug, body);
  }

  /**
   * The calling session as a principal. Whether it is a maintenance run of the space the service asks,
   * after the space is found; this only proves the session is one this runner hosts for its owner.
   */
  private async maintainer(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<WikiPrincipal> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException(
        'missing session context: only a Wiki maintenance run of this space writes its articles, so this door needs X-Orbit-Session-Id',
      );
    }
    let sessionId: string;
    try {
      sessionId = toUuid(named);
    } catch {
      throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    }
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId: runner.ownerId, assignedRunnerId: runner.id, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    return { origin: 'maintenance', ownerId: runner.ownerId, userId: null, sessionId, toolCallId: null };
  }
}
