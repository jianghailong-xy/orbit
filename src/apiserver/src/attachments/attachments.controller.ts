import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
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
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { FILE_UPLOAD_STORAGE, type FileUpload } from '../files/file-upload-storage';
import { streamable } from '../files/files.service';
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
  // bounds what it may write.
  @PatScope('tasks:write', { workspaceConfinable: false })
  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: FILE_UPLOAD_STORAGE, limits: { fileSize: MAX_UPLOAD_BYTES } }))
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
