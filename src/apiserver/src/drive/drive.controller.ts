import {
  Body, Controller, Delete, Get, Headers, HttpCode, HttpException, HttpStatus, Param, ParseIntPipe, Patch, Post, Put, Query, Req, Res,
  StreamableFile, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { DRIVE_CHUNK_MAX, DRIVE_CHUNK_TOO_LARGE, DriveChunksService } from './drive-chunks.service';
import { DriveContentService, type DriveContent } from './drive-content.service';
import { DriveUploadsService } from './drive-uploads.service';
import { DriveService } from './drive.service';
import { CreateDriveFolderDto, OpenDriveUploadDto, RestoreDriveVersionDto, UpdateDriveEntryDto } from './dto';

/** What every drive route declares for a token: the files scope; a drive holds no workspace, so a confined token is refused. */
export const DRIVE_PAT = () => PatScope('files', { workspaceConfinable: false });

const limitOf = (limit?: string) => (limit === undefined ? undefined : Number.parseInt(limit, 10));

/**
 * The owner's drive routes (docs/orbit-files-drive-technical-design.md §4.1), under the owner's login: folders and files,
 * versions, Trash and the change feed. The owner is always the credential's; another account's entry, version or group
 * is not found. Usage and the share check are their own tasks' routes. A token reaches them with the
 * `files` scope (DRIVE_PAT), declared on each handler like every scope; without it the guard refuses with the scope's 403.
 */
@UseGuards(JwtAuthGuard)
@Controller('drive')
export class DriveController {
  constructor(
    private readonly drive: DriveService,
    private readonly uploads: DriveUploadsService,
    private readonly chunks: DriveChunksService,
    private readonly content: DriveContentService,
  ) {}

  @DRIVE_PAT()
  @Get('entries')
  list(
    @CurrentUser() user: AuthUser,
    @Query('parentId', PublicIdPipe) parentId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.drive.list(user.userId, { parentId, cursor, limit: limitOf(limit) });
  }

  @DRIVE_PAT()
  @Get('entries/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.drive.get(user.userId, id);
  }

  @DRIVE_PAT()
  @Get('resolve')
  resolve(@CurrentUser() user: AuthUser, @Query('path') path?: string) {
    return this.drive.resolve(user.userId, path ?? '');
  }

  @DRIVE_PAT()
  @Post('folders')
  createFolder(@CurrentUser() user: AuthUser, @Body() dto: CreateDriveFolderDto) {
    return this.drive.createFolder(user.userId, { parentId: dto.parentId ?? null, name: dto.name, onClash: 'SUFFIX' });
  }

  @DRIVE_PAT()
  @Patch('entries/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateDriveEntryDto) {
    return this.drive.rename(user.userId, id, { name: dto.name, parentId: dto.parentId, replace: false });
  }

  /** Move to Trash; answers the group, which the web's undo restores. */
  @DRIVE_PAT()
  @Delete('entries/:id')
  moveToTrash(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.drive.moveToTrash(user.userId, id);
  }

  @DRIVE_PAT()
  @Get('entries/:id/versions')
  versions(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.drive.versions(user.userId, id);
  }

  @DRIVE_PAT()
  @Post('versions/:id/restore')
  @HttpCode(HttpStatus.OK)
  restoreVersion(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: RestoreDriveVersionDto) {
    return this.drive.restoreVersion(user.userId, id, dto.as);
  }

  @DRIVE_PAT()
  @Delete('versions/:id')
  deleteVersion(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.drive.deleteVersion(user.userId, id);
  }

  @DRIVE_PAT()
  @Get('trash')
  trash(@CurrentUser() user: AuthUser, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.drive.trash(user.userId, { cursor, limit: limitOf(limit) });
  }

  @DRIVE_PAT()
  @Get('trash/groups/:id')
  trashGroup(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('parentId', PublicIdPipe) parentId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.drive.trashGroup(user.userId, id, { parentId, cursor, limit: limitOf(limit) });
  }

  @DRIVE_PAT()
  @Post('trash/groups/:id/restore')
  @HttpCode(HttpStatus.OK)
  restoreGroup(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.drive.restoreGroup(user.userId, id);
  }

  /** Delete a group for good. */
  @DRIVE_PAT()
  @Delete('trash/groups/:id')
  deleteGroup(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.drive.deleteGroup(user.userId, id);
  }

  /** Empty Trash. */
  @DRIVE_PAT()
  @Delete('trash')
  emptyTrash(@CurrentUser() user: AuthUser) {
    return this.drive.emptyTrash(user.userId);
  }

  /** The change feed (§5.4): `since` is the cursor the previous call answered. Also announced as `drive.changed`. */
  @DRIVE_PAT()
  @Get('changes')
  changes(@CurrentUser() user: AuthUser, @Query('since') since?: string) {
    return this.drive.changes(user.userId, since);
  }

  // ── uploads and downloads (§4.1) ──────────────────────────────────────────────────────────────

  /** Open a resumable upload: answers the staging id and the chunk size every chunk but the last must have. */
  @DRIVE_PAT()
  @Post('uploads')
  openUpload(@CurrentUser() user: AuthUser, @Body() dto: OpenDriveUploadDto) {
    return this.uploads.open(user.userId, {
      parentId: dto.parentId ?? null, name: dto.name, size: dto.size, relativePath: dto.relativePath, dropRootId: dto.dropRootId ?? null,
    });
  }

  /** Which chunks have arrived. */
  @DRIVE_PAT()
  @Get('uploads/:id')
  uploadStatus(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.uploads.status(user.userId, id);
  }

  /** One chunk, at most 8 MiB, as the raw request body, with its sha256 in `X-Orbit-Chunk-Sha256`. Sent again, it replaces. */
  @DRIVE_PAT()
  @Put('uploads/:id/chunks/:idx')
  async putChunk(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('idx', ParseIntPipe) idx: number,
    @Headers('x-orbit-chunk-sha256') sha256: string | undefined,
    @Req() req: Request,
  ) {
    await this.uploads.assertOpen(user.userId, id);
    if (Number(req.headers['content-length'] ?? 0) > DRIVE_CHUNK_MAX) {
      req.resume();
      throw new HttpException(
        { code: DRIVE_CHUNK_TOO_LARGE, message: `A chunk is at most ${DRIVE_CHUNK_MAX} bytes (8 MiB); cut the file into smaller parts.` },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    return this.chunks.putChunk(user.userId, id, idx, (sha256 ?? '').toLowerCase(), req);
  }

  /** Create the file and commit it; sent again after it applied, it answers the same file. */
  @DRIVE_PAT()
  @Post('uploads/:id/complete')
  @HttpCode(HttpStatus.OK)
  completeUpload(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.uploads.complete(user.userId, id);
  }

  @DRIVE_PAT()
  @Delete('uploads/:id')
  abandonUpload(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.uploads.abandon(user.userId, id);
  }

  /** Download the current version, with `Range` (206) and an ETag of `"<versionId>.<seq>"`. */
  @DRIVE_PAT()
  @Get('entries/:id/content')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Headers('range') range: string | undefined,
    @Headers('if-range') ifRange: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.content.ofEntry(user.userId, id, { range, ifRange, ifNoneMatch }), res);
  }

  /** Download one version, current or replaced. */
  @DRIVE_PAT()
  @Get('versions/:id/content')
  async downloadVersion(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Headers('range') range: string | undefined,
    @Headers('if-range') ifRange: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.content.ofVersion(user.userId, id, { range, ifRange, ifNoneMatch }), res);
  }
}

function send(content: DriveContent, res: Response): StreamableFile | undefined {
  res.status(content.status);
  for (const [name, value] of Object.entries(content.headers)) res.setHeader(name, value);
  if (!content.stream) return undefined;
  // A client that leaves early does not hold the store open.
  const stream = content.stream;
  res.once('close', () => stream.destroy());
  return new StreamableFile(stream);
}
