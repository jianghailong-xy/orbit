import { Module } from '@nestjs/common';
import { SessionTagsModule } from '../session-tags/session-tags.module';
import { QuotaRetryService } from './quota-retry.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [SessionTagsModule],
  controllers: [SessionsController],
  // QuotaRetryService lives here rather than beside the reaper so it can depend on
  // SessionsService directly — re-sending a message is exactly resume(), and reimplementing
  // that (capability checks, the row lock, inbox fencing) is how the two would drift.
  providers: [SessionsService, QuotaRetryService],
  exports: [SessionsService],
})
export class SessionsModule {}
