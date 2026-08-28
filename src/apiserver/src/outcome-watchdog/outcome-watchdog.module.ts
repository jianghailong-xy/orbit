import { Module } from '@nestjs/common';
import { OutcomeWatchdogService } from './outcome-watchdog.service';

/**
 * This module is safe to import for API adapters, but it starts no timer. The polling provider is
 * deliberately hosted by OutcomeWatchdogWorkerModule in a separate Node process.
 */
@Module({
  providers: [OutcomeWatchdogService],
  exports: [OutcomeWatchdogService],
})
export class OutcomeWatchdogModule {}
