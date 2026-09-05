import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile as UploadedFileParam,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { AttachmentsService } from './attachments.service';
import { MAX_UPLOAD_BYTES, UploadedFile } from './attachments.media';

@UseGuards(JwtAuthGuard)
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // multipart/form-data with a `file` field. We use multipart (not base64 JSON) because
  // the app sets no raised body limit, so Express' ~100kb JSON cap would 413 real images;
  // multipart also avoids base64's ~33% inflation. `limits.fileSize` bounds buffered memory.
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFileParam() file: UploadedFile | undefined,
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
  @Delete(':id')
  @HttpCode(204)
  removeTaskInput(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<void> {
    return this.attachments.removeTaskInput(user.userId, id);
  }

  @Get(':id')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<StreamableFile> {
    const { data, mimeType } = await this.attachments.getForOwner(user.userId, id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline', length: data.length });
  }
}
