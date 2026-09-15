import { Global, Module } from '@nestjs/common';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { PushModule } from '../push/push.module';
import { RealtimeService } from './realtime.service';
import { ReaperService } from './reaper.service';

@Global()
@Module({
  // The reaper reclaims tasks, so it opens their projects' exception items and has to hand them over
  // afterwards (`ProjectOpenItemService`, contract §4.3 D). Imported rather than reached for through
  // the global scope so the dependency is visible where the module is declared.
  imports: [PushModule, CoordinatorJudgmentModule],
  providers: [RealtimeService, ReaperService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
