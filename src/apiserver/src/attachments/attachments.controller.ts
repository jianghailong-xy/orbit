import {
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
import { streamable, type FileView, type StorageUsage } from '../files/files.service';
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
