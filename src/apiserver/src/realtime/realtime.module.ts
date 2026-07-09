import { Global, Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { RealtimeService } from './realtime.service';
import { ReaperService } from './reaper.service';

@Global()
@Module({
  imports: [PushModule],
  providers: [RealtimeService, ReaperService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
