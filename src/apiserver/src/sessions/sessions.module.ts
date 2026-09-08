import { Module, forwardRef } from '@nestjs/common';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { SessionTagsModule } from '../session-tags/session-tags.module';
import { AutoRetryService } from './auto-retry.service';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  // AutoRetryService announces the failure it just gave up retrying through RealtimeService,
  // which is @Global (RealtimeModule) and needs no import here.
  //
  // CoordinatorJudgmentModule is a RING and says so: it imports this module, because opening a
  // judgment session and writing to a project's standing conversation are both SessionsService.
  // MergeReceiptService closes the ring on purpose — a committed merge receipt is the last missing
  // input of PROJECT_ACCEPTANCE_LANDED and the whole subject of CRITERION_UNLANDED, and until this
  // import existed no receipt writer knocked on any delivery door. `forwardRef` on BOTH sides is
  // what lets Nest resolve the pair; the argument for choosing this over the shapes that avoid the
  // ring is in `merge-receipt.service.ts`'s constructor.
  imports: [SessionTagsModule, forwardRef(() => CoordinatorJudgmentModule)],
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
