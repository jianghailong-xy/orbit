import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile as UploadedFileParam,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { PublicIdPipe } from '../common/public-id';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { TerminalRoute } from '../auth/terminal-credentials';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { FileUploadCleanupInterceptor } from '../files/file-upload-cleanup.interceptor';
import { FILE_UPLOAD_STORAGE, type FileUpload } from '../files/file-upload-storage';
import { streamable, type FileView, type StorageUsage, type StoredFilesPage, type StoredFilesScope } from '../files/files.service';
import { AttachmentsService } from './attachments.service';
import { MAX_UPLOAD_BYTES } from './attachments.media';

@UseGuards(JwtAuthGuard)
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // multipart/form-data with a `file` field. We use multipart (not base64 JSON) because
  // the app sets no raised body limit, so Express' ~100kb JSON cap would 413 real images;
  // multipart also avoids base64's ~33% inflation. The file streams to a temporary file on disk
  // and is hashed on the way (FILE_UPLOAD_STORAGE), never held in memory whole; `limits.fileSize`
  // bounds what it may write, and FileUploadCleanupInterceptor removes it however the request ends.
  @PatScope('tasks:write', { workspaceConfinable: false })
  // A terminal attaches a file to a session on its own machine, and to nothing else (no task inputs).
  @TerminalRoute('SESSION_UPLOAD')
  @Post()
  @UseInterceptors(
    FileUploadCleanupInterceptor,
    FileInterceptor('file', { storage: FILE_UPLOAD_STORAGE, limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFileParam() file: FileUpload | undefined,
    @Query('sessionId', PublicIdPipe) sessionId?: string,
    // The task an input belongs to (a design mock, a spec). Mutually exclusive with sessionId:
    // one scopes a blob to a conversation, the other to the work, and a row that claimed both
    // would be handed to a runner AND listed as the task's input (see migration 0241's CHECK).
    @Query('taskId', PublicIdPipe) taskId?: string,
  ): Promise<{ id: string }> {
    return this.attachments.create(user.userId, sessionId, file, taskId);
  }

  // Task inputs only — see AttachmentsService.removeTaskInput for why a transcript's image is
  // not deletable through here.
  @PatScope('tasks:write', { workspaceConfinable: false })
  @Delete(':id')
  @HttpCode(204)
  removeTaskInput(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<void> {
    return this.attachments.removeTaskInput(user.userId, id);
  }

  // What Settings shows of this account's files. Ahead of `:id`, which would take `usage` for an id.
  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get('usage')
  usage(@CurrentUser() user: AuthUser): Promise<StorageUsage> {
    return this.attachments.usage(user.userId);
  }

  // The files one row of Settings → Storage counts (docs/orbit-files-design.md §2.10). Ahead of `:id`, as `usage` is.
  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get('usage/projects/:id/files')
  projectFiles(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
  ): Promise<StoredFilesPage> {
    return this.listed(user, { kind: 'project', id }, order, cursor);
  }

  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get('usage/tasks/:id/files')
  taskFiles(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
  ): Promise<StoredFilesPage> {
    return this.listed(user, { kind: 'task', id }, order, cursor);
  }

  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get('usage/weeks/:week/files')
  weekFiles(
    @CurrentUser() user: AuthUser,
    @Param('week') week: string,
    @Query('order') order?: string,
    @Query('cursor') cursor?: string,
  ): Promise<StoredFilesPage> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || Number.isNaN(Date.parse(`${week}T00:00:00Z`))) {
      throw new BadRequestException('week must be a date, YYYY-MM-DD');
    }
    return this.listed(user, { kind: 'week', weekStart: week }, order, cursor);
  }

  private listed(user: AuthUser, scope: StoredFilesScope, order: string | undefined, cursor: string | undefined): Promise<StoredFilesPage> {
    if (order !== undefined && order !== 'size' && order !== 'newest') throw new BadRequestException('order must be size or newest');
    return this.attachments.storedFiles(user.userId, scope, order ?? 'size', cursor ?? null);
  }

  // Delete a file from Settings → Storage: every row of it this account keeps, as expiry would. 409 FILE_HELD while evidence
  // or a session holds it.
  @PatScope('tasks:write', { workspaceConfinable: false })
  @Delete(':id/everywhere')
  @HttpCode(204)
  deleteEverywhere(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<void> {
    return this.attachments.deleteEverywhere(user.userId, id);
  }

  // A pin keeps a file past its date (docs/orbit-files-design.md §2.8), and brings an expired one back while its bytes remain.
  @PatScope('tasks:write', { workspaceConfinable: false })
  @Put(':id/pin')
  pin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<FileView> {
    return this.attachments.setPinned(user.userId, id, true);
  }

  @PatScope('tasks:write', { workspaceConfinable: false })
  @Delete(':id/pin')
  unpin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<FileView> {
    return this.attachments.setPinned(user.userId, id, false);
  }

  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get(':id')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<StreamableFile> {
    return streamable(await this.attachments.getForOwner(user.userId, id), res);
  }
}
