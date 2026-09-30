import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { WikiDocs } from '../wiki/wiki-docs';
import { WikiRolloutGuard } from '../wiki/wiki-rollout';
import type { WikiPrincipal } from '../wiki/wiki.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The documents, on the runner door (contracts/wiki.contract.json `docs.routes`,
 * `agentSurface.doors.runner.maintenanceRoutes`): what a maintenance run's writer asks — what is written
 * already, one document as it is written, the server's half of a section's material, and the write of
 * one document's sections.
 *
 * ONLY A MAINTENANCE RUN OF THE SPACE. The calling session (`X-Orbit-Session-Id`, one this runner hosts
 * for its owner) is the principal, and `WikiDocs.assertWriter` asks it the one test criterion 2 exported
 * (`isWikiMaintenanceSession`): any other session of the owner is refused WIKI_NOT_MAINTENANCE_SESSION, a
 * headless call 400, and another owner's space is the plain 404.
 *
 * A controller of its own beside the articles' and the plan's, so that none injects anything it did not.
 */
@UseGuards(RunnerAuthGuard, WikiRolloutGuard)
@Controller('runner/wiki')
export class RunnerWikiDocsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: WikiDocs,
  ) {}

  /** Every written document of the space with its sections' fingerprints, and the confirmed plan's version. */
  @Get('spaces/:id/docs')
  async state(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.docs.writerState(await this.maintainer(runner, callingSessionId), id);
  }

  /** One document as it is written: the owner's read, for a run that writes an overview over sections it left as they are. */
  @Get('spaces/:id/docs/:slug')
  async doc(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('slug') slug: string,
  ) {
    return this.docs.writerDoc(await this.maintainer(runner, callingSessionId), id, slug);
  }

  /** The server's half of one section's material: its condition's entries and records, redacted and placed. */
  @Get('spaces/:id/docs/:slug/material')
  async material(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('slug') slug: string,
    @Query('section') section: string | undefined,
  ) {
    return this.docs.material(await this.maintainer(runner, callingSessionId), id, slug, section);
  }

  /** Sections of one document, checked and stored; a section whose material did not change is left as it is. */
  @Post('spaces/:id/docs/:slug')
  @HttpCode(HttpStatus.OK)
  async write(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('slug') slug: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.docs.write(await this.maintainer(runner, callingSessionId), id, slug, body);
  }

  /**
   * The calling session as a principal. Whether it is a maintenance run of the space the service asks,
   * after the space is found; this only proves the session is one this runner hosts for its owner.
   */
  private async maintainer(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<WikiPrincipal> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException(
        'missing session context: only a Wiki maintenance run of this space writes its documents, so this door needs X-Orbit-Session-Id',
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
