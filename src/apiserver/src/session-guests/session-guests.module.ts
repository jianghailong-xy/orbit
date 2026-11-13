import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { GuestSessionsController, SessionGuestsController } from './session-guests.controller';
import { SessionGuestsService } from './session-guests.service';

// Session guests (docs/session-guests-design.md): the owner's People routes and the guest's door. Turns go through
// SessionsService (exported by its module), as the owner's own.
@Module({
  imports: [SessionsModule],
  controllers: [SessionGuestsController, GuestSessionsController],
  providers: [SessionGuestsService],
})
export class SessionGuestsModule {}
