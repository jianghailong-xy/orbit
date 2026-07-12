import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminProvidersController } from './admin-providers.controller';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  controllers: [ProvidersController, AdminProvidersController],
  // AdminRoleGuard depends only on the global PrismaService, so provide it here too (it is
  // not exported from UsersModule) for the admin controller's @UseGuards.
  providers: [ProvidersService, AdminRoleGuard],
})
export class ProvidersModule {}
