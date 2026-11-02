import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

// PrismaService comes from the @Global() PrismaModule, so it needs no import here.
// AttachmentsService is exported so the API-layer work (turn → attachment wiring) can reuse it.
// FilesModule keeps the bytes (files/files.service.ts); it is global, and this import is what brings it in.
@Module({
  imports: [FilesModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
