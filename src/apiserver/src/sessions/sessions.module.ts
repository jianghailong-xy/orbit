import { Module } from '@nestjs/common';
import { SessionTagsModule } from '../session-tags/session-tags.module';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  // AutoRetryService announces the failure it just gave up retrying through RealtimeService,
  // which is @Global (RealtimeModule) and needs no import here.
  imports: [SessionTagsModule],
  controllers: [SessionsController],
  // AutoRetryService lives here rather than beside the reaper so it can depend on
  // SessionsService directly — re-sending a message is exactly resume(), and reimplementing
  // that (capability checks, the row lock, inbox fencing) is how the two would drift.
  providers: [SessionsService, AutoRetryService, MergeReceiptService],
  // Exported so the runner door and the user door write receipts through ONE instance — a second
  // provider entry would be a second object, which is how the auto-run sweep once ran twice.
  exports: [SessionsService, MergeReceiptService],
})
export class SessionsModule {}
