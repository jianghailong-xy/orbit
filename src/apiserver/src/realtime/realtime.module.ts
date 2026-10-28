import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorJudgmentModule } from '../projects/coordinator-judgment.module';
import { PushModule } from '../push/push.module';
import { RunnerPresenceService } from '../runners/runner-presence';
import { ControlPlaneLeader } from './control-plane-leader';
import { RealtimeService } from './realtime.service';
import { ReaperService } from './reaper.service';
import { RunnerHints } from './runner-hints';

@Global()
@Module({
  // The reaper reclaims tasks, so it opens their projects' exception items and has to hand them over
  // afterwards (`ProjectOpenItemService`, contract §4.3 D). Imported rather than reached for through
  // the global scope so the dependency is visible where the module is declared.
  imports: [PushModule, CoordinatorJudgmentModule],
  // RunnerPresenceService beside the reaper that asks it whether a runner's silence is evidence, and
  // exported so the heartbeat that writes presence tells the same instance when a write fails.
  // ControlPlaneLeader decides which apiserver process runs the reaper, and is exported to the task
  // sweep and the auto-retry sweep, which run on the same process (control-plane-leader.ts).
  providers: [
    RealtimeService,
    ReaperService,
    RunnerPresenceService,
    ControlPlaneLeader,
    // The runner link's hints on NATS (runner-hints.ts), read from configuration once.
    {
      provide: RunnerHints,
      inject: [PrismaService, ConfigService],
      useFactory: (prisma: PrismaService, config: ConfigService) => RunnerHints.fromConfig(prisma, config),
    },
  ],
  exports: [RealtimeService, RunnerPresenceService, RunnerHints, ControlPlaneLeader],
})
export class RealtimeModule {}
