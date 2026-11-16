import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SessionsModule } from '../sessions/sessions.module';
import { GuestSessionsController, SessionGuestsController } from './session-guests.controller';
import { SessionGuestsService } from './session-guests.service';

// Session guests (docs/session-guests-design.md): the owner's People routes and the guest's door. Turns go through
// SessionsService (exported by its module), as the owner's own; a transcript's images are read through AttachmentsService.
@Module({
  imports: [SessionsModule, AttachmentsModule],
  controllers: [SessionGuestsController, GuestSessionsController],
  providers: [SessionGuestsService],
})
export class SessionGuestsModule {}
