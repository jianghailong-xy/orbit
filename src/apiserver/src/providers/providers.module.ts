import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminProvidersController } from './admin-providers.controller';
import { ModelCatalogService } from './model-catalog.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  controllers: [ProvidersController, AdminProvidersController],
  // AdminRoleGuard depends only on the global PrismaService, so provide it here too (it is
  // not exported from UsersModule) for the admin controller's @UseGuards.
  providers: [ProvidersService, ModelCatalogService, ProviderPlanUsageService, AdminRoleGuard],
  // For RunnerApiModule's provider list. Exported rather than re-provided there: a second
  // provider entry would be a second instance, which is how the auto-run sweep once ran twice.
  exports: [ProvidersService],
})
export class ProvidersModule {}
