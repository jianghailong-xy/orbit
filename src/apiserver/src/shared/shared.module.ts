import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SharedController } from './shared.controller';

// Hosts the public (unauthenticated) share routes. It owns no providers — it reuses
// SessionsService and AttachmentsService from their modules (both export the service).
@Module({
  imports: [SessionsModule, AttachmentsModule],
  controllers: [SharedController],
})
export class SharedModule {}
