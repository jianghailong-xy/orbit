import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { FeishuAdminController } from './feishu-admin.controller';
import { FeishuAppService } from './feishu-app.service';
import { FeishuController } from './feishu.controller';

/**
 * The Feishu bot integration (docs/feishu-bot-design.md): each account's own Feishu (Lark) app, and the
 * administrators' switch for them.
 */
@Module({
  controllers: [FeishuController, FeishuAdminController],
  // AdminRoleGuard depends only on the global PrismaService, so it is provided here too (UsersModule does not export it).
  providers: [FeishuAppService, AdminRoleGuard],
  exports: [FeishuAppService],
})
export class FeishuModule {}
