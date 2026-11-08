import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { CreateFileBundleDto } from '../files/file-tools.dto';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertEngineSession } from '../sessions/engine-session';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * What `file_list`, `file_fetch` and a folder's `file_upload` call (docs/orbit-files-design.md §2.2, §2.3): the agent
 * tool API, so it speaks public ids and stays on HTTPS (D14). The upload of a file itself is
 * RunnerApiController's, beside the other upload, and a file's bytes are read from the attachment route.
 *
 * A file is read as the attachment route reads it, by a session this runner hosts, under the one rule for which files
 * that session may read (`FilesService.readableInSession`, §2.7). Listing is the owner's: `file_list` says what exists,
 * and hands over no bytes.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerFilesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  /** The owner's files of one task, one session or one evidence version. */
  @Get('files')
  list(
    @CurrentRunner() runner: Runner,
    @Query('taskId', PublicIdPipe) taskId?: string,
    @Query('sessionId', PublicIdPipe) sessionId?: string,
    @Query('evidenceId', PublicIdPipe) evidenceId?: string,
  ) {
    return this.files.listFiles(runner.ownerId, { taskId, sessionId, evidenceId });
  }

  /** What `file_fetch` needs before the bytes: what the file is called, and the sha256 they must match. */
  @Get('sessions/:id/files/:fileId')
  async describe(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('fileId', PublicIdPipe) fileId: string,
  ) {
    const session = await this.hostedSession(runner, sessionId);
    const file = await this.files.describeFile(await this.files.readableInSession(session, fileId));
    if (!file) throw new NotFoundException('file not found in this session');
    return file;
  }

  /** `file_pin`: a file this session may read stays past its date (§2.8). */
  @Put('sessions/:id/files/:fileId/pin')
  pin(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('fileId', PublicIdPipe) fileId: string,
  ) {
    return this.setPinned(runner, sessionId, fileId, true);
  }

  /** `file_pin` with `unpin`: the file goes back to the date its references give it. */
  @Delete('sessions/:id/files/:fileId/pin')
  unpin(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('fileId', PublicIdPipe) fileId: string,
  ) {
    return this.setPinned(runner, sessionId, fileId, false);
  }

  private async setPinned(runner: Runner, sessionId: string, fileId: string, pinned: boolean) {
    const session = await this.hostedSession(runner, sessionId);
    const file = await this.files.setPinned(await this.files.readableInSession(session, fileId), pinned);
    if (!file) throw new NotFoundException('file not found in this session');
    return file;
  }

  /** A folder's manifest, once its files are uploaded. */
  @Post('sessions/:id/file-bundles')
  async createBundle(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: CreateFileBundleDto,
  ) {
    return this.files.createBundle(await this.hostedSession(runner, sessionId), dto);
  }

  /** A session this runner hosts, answered as RunnerApiController answers any other: the same whoever's it is. */
  private async hostedSession(runner: Runner, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId: runner.ownerId, deletedAt: null },
      select: { id: true, ownerId: true, taskId: true, assignedRunnerId: true, sessionKind: true },
    });
    if (session) assertEngineSession(session);
    if (session?.assignedRunnerId !== runner.id) throw new ForbiddenException('session does not belong to this runner');
    return session;
  }
}
