import { Module } from '@nestjs/common';

import { WatchEvaluatorService } from './watch-evaluator.service';

/**
 * The Watch evaluator: one shared loop per replica that claims due watches under a lease and lands
 * their evaluation. PrismaService and RealtimeService come from their global modules.
 */
@Module({
  providers: [WatchEvaluatorService],
  exports: [WatchEvaluatorService],
})
export class WatchEvaluatorModule {}
