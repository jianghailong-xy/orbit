import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile as UploadedFileParam,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
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
    @Query('sessionId') sessionId?: string,
  ): Promise<{ id: string }> {
    return this.attachments.create(user.userId, sessionId, file);
  }

  @Get(':id')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { data, mimeType } = await this.attachments.getForOwner(user.userId, id);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline', length: data.length });
  }
}
