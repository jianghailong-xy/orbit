import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminProvidersController } from './admin-providers.controller';
import { ModelCatalogService } from './model-catalog.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { PoolGatewayController } from './pool-gateway.controller';
import { OPENAI_API_BASE, POOL_GATEWAY_UPSTREAM, PoolGatewayService } from './pool-gateway.service';
import { PoolUsageLedger } from './pool-usage-ledger';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { SharedPoolsController } from './shared-pools.controller';
import { SharedPoolsService } from './shared-pools.service';

@Module({
  controllers: [ProvidersController, AdminProvidersController, SharedPoolsController, PoolGatewayController],
  // AdminRoleGuard depends only on the global PrismaService, so provide it here too (it is
  // not exported from UsersModule) for the admin controller's @UseGuards.
  providers: [
    ProvidersService,
    ModelCatalogService,
    ProviderPlanUsageService,
    AdminRoleGuard,
    SharedPoolsService,
    PoolGatewayService,
    PoolUsageLedger,
    // The shared pools' gateway forwards to OpenAI and nowhere else (pool-gateway.service.ts).
    { provide: POOL_GATEWAY_UPSTREAM, useValue: OPENAI_API_BASE },
  ],
  // For RunnerApiModule's provider list, and for QueueModule's claim, which reads an account pool's
  // quota. Exported rather than re-provided there: a second provider entry would be a second
  // instance — for the quota, a second cache that starts cold — which is how the auto-run sweep
  // once ran twice.
  exports: [ProvidersService, ProviderPlanUsageService],
})
export class ProvidersModule {}
