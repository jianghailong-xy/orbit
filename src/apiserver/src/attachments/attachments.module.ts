import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

// PrismaService comes from the @Global() PrismaModule, so it needs no import here.
// AttachmentsService is exported so the API-layer work (turn → attachment wiring) can reuse it.
@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
