import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { DispatchPauseService } from './dispatch-pause.service';
import { DispatchPauseController } from './dispatch-pause.controller';
import { QueueService } from './queue.service';

@Global()
@Module({
  // ProviderPlanUsageService: a claim on an account pool picks its member by quota.
  imports: [ProvidersModule],
  controllers: [DispatchPauseController],
  // AdminRoleGuard depends only on the global PrismaService, so it is provided here too (UsersModule does not
  // export it).
  providers: [QueueService, DispatchPauseService, AdminRoleGuard],
  exports: [QueueService],
})
export class QueueModule {}
