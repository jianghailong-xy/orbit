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
import { FilesService, type DriveUsage } from '../files/files.service';
import { DriveService } from './drive.service';
import { DriveDownloadLinks } from './drive-download-links';
import { DRIVE_ROUTE_PREFIXES } from './drive-routes';
import { DriveEnabledGuard } from './drive-switch';
import { CreateDriveFolderDto, DriveDownloadLinkDto, OpenDriveUploadDto, RestoreDriveVersionDto, UpdateDriveEntryDto } from './dto';
import { DriveSyncsService, type DriveSyncView } from './drive-syncs.service';

/** What every Drive route declares for a token: the drive scope; Drive holds no workspace, so a confined token is refused. */
export const DRIVE_PAT = () => PatScope('drive', { workspaceConfinable: false });

const limitOf = (limit?: string) => (limit === undefined ? undefined : Number.parseInt(limit, 10));

/**
 * The owner's drive routes (docs/drive-technical-design.md §4.1), under the owner's login: folders and files,
 * versions, Trash and the change feed. The owner is always the credential's; another account's entry, version or group
 * is not found. Usage and the share check are their own tasks' routes. A token reaches them with the
 * `drive` scope (DRIVE_PAT), declared on each handler like every scope; without it the guard refuses with the scope's 403.
 */
@UseGuards(JwtAuthGuard, DriveEnabledGuard)
@Controller(DRIVE_ROUTE_PREFIXES)
export class DriveController {
  constructor(
    private readonly drive: DriveService,
    private readonly uploads: DriveUploadsService,
    private readonly chunks: DriveChunksService,
    private readonly content: DriveContentService,
    private readonly downloadLinks: DriveDownloadLinks,
    private readonly files: FilesService,
    private readonly syncs: DriveSyncsService,
  ) {}

  /** Agents' directory syncs for the upload tray: running ones and those ended in the last day (S4). */
  @DRIVE_PAT()
  @Get('syncs')
  listSyncs(@CurrentUser() user: AuthUser): Promise<{ syncs: DriveSyncView[] }> {
    return this.syncs.list(user.userId);
  }

  /** One agent's sync, whatever its age: the conversation's sync card for the call that started it. */
  @DRIVE_PAT()
  @Get('syncs/:id')
  getSync(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<DriveSyncView> {
    return this.syncs.get(user.userId, id);
  }

  // What Files → Storage shows: the drive's share and the rest, each content once (§2.5).
  @DRIVE_PAT()
  @Get('usage')
  usage(@CurrentUser() user: AuthUser): Promise<DriveUsage> {
    return this.files.driveUsage(user.userId);
  }

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

  /** Live entries whose name contains `q`, anywhere in the drive, each with its folder path. */
  @DRIVE_PAT()
  @Get('search')
  search(@CurrentUser() user: AuthUser, @Query('q') q?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.drive.search(user.userId, { q, cursor, limit: limitOf(limit) });
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

  /** Restore one item of a group, and what hangs under it, leaving the rest in Trash (board frame 6, rule 3). */
  @DRIVE_PAT()
  @Post('trash/groups/:id/items/:entryId/restore')
  @HttpCode(HttpStatus.OK)
  restoreItem(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('entryId', PublicIdPipe) entryId: string,
  ) {
    return this.drive.restoreItem(user.userId, id, entryId);
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

  /**
   * A short-lived URL that downloads the current version (or `versionId`) without a login header, for the browser to
   * navigate to and stream to disk itself (D12: no size limit). Answers `{ path, expiresAt }`; `path` is under /api.
   */
  @DRIVE_PAT()
  @Post('entries/:id/download-link')
  @HttpCode(HttpStatus.OK)
  downloadLink(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: DriveDownloadLinkDto) {
    return this.downloadLinks.mint(user.userId, id, dto.versionId);
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

  /** The secret scan before sharing a file (§9): warns, naming the shape and line, and never blocks. */
  @DRIVE_PAT()
  @Post('entries/:id/share-check')
  @HttpCode(HttpStatus.OK)
  async shareCheck(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    const version = await this.drive.shareableVersion(user.userId, id);
    return { versionId: version.id, ...(await this.content.shareCheck(user.userId, version.id)) };
  }
}

function send(content: DriveContent, res: Response): StreamableFile | undefined {
  res.status(content.status);
  for (const [name, value] of Object.entries(content.headers)) res.setHeader(name, value);
  if (!content.stream) return undefined;
  // A client that leaves early does not hold the store open.
  const stream = content.stream;
  res.once('close', () => stream.destroy());
  // The file rule (UserFileResponseInterceptor) reads these from the StreamableFile, not from the headers set above.
  return new StreamableFile(stream, { type: content.headers['Content-Type'], disposition: content.headers['Content-Disposition'] });
}

/**
 * The download URL a Files page minted (`POST /drive/entries/:id/download-link`), opened by a navigation that carries no
 * login: the signed token is the credential, bound to one owner, file and version, and expired, forged or stale it is the
 * one 404. Range, If-Range and If-None-Match work as on the owner's content route.
 */
@UseGuards(DriveEnabledGuard)
@Controller(DRIVE_ROUTE_PREFIXES)
export class DriveDownloadController {
  constructor(private readonly downloadLinks: DriveDownloadLinks) {}

  @Get('dl/:token')
  async open(
    @Param('token') token: string,
    @Headers('range') range: string | undefined,
    @Headers('if-range') ifRange: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return send(await this.downloadLinks.open(token, { range, ifRange, ifNoneMatch }), res);
  }
}
