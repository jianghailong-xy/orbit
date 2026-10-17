import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { CreateSessionFolderDto, RenameSessionFolderDto } from './dto';
import { SessionFoldersService } from './session-folders.service';

// Filing a session in a folder is `POST /sessions/:id/move`, beside the session's other doors.
@UseGuards(JwtAuthGuard)
@Controller('session-folders')
export class SessionFoldersController {
  constructor(private readonly folders: SessionFoldersService) {}

  /** The caller's folders across all their workspaces, by name: `{ id, workspaceId, name }`. */
  @PatScope('sessions:read', { workspaceConfinable: false })
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.folders.list(user.userId);
  }

  /** A folder in one of the caller's workspaces. A name the workspace already has is a 409. */
  @PatScope('sessions:write', { workspaceConfinable: false })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSessionFolderDto) {
    return this.folders.create(user.userId, dto);
  }

  @PatScope('sessions:write', { workspaceConfinable: false })
  @Patch(':id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RenameSessionFolderDto,
  ) {
    return this.folders.rename(user.userId, id, dto);
  }

  /** Delete the folder only; the sessions in it go back to the workspace's list. */
  @PatScope('sessions:write', { workspaceConfinable: false })
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.folders.remove(user.userId, id);
  }
}
