import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { QueueService } from './queue.service';

@Global()
@Module({
  // ProviderPlanUsageService: a claim on an account pool picks its member by quota.
  imports: [ProvidersModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
