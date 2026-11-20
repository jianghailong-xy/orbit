import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { DriveService } from './drive.service';
import { CreateDriveFolderDto, RestoreDriveVersionDto, UpdateDriveEntryDto } from './dto';

/** What every drive route declares for a token: the files scope; a drive holds no workspace, so a confined token is refused. */
export const DRIVE_PAT = () => PatScope('files', { workspaceConfinable: false });

const limitOf = (limit?: string) => (limit === undefined ? undefined : Number.parseInt(limit, 10));

/**
 * The owner's drive routes (docs/orbit-files-drive-technical-design.md §4.1), under the owner's login: folders and files,
 * versions, Trash and the change feed. The owner is always the credential's; another account's entry, version or group
 * is not found. Uploads and downloads, usage and the share check are their own tasks' routes. A token reaches them with the
 * `files` scope (DRIVE_PAT), declared on each handler like every scope; without it the guard refuses with the scope's 403.
 */
@UseGuards(JwtAuthGuard)
@Controller('drive')
export class DriveController {
  constructor(private readonly drive: DriveService) {}

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
}
