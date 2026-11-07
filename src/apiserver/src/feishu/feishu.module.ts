import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { FeishuAdminController } from './feishu-admin.controller';
import { FeishuAppService } from './feishu-app.service';
import { FeishuController } from './feishu.controller';
import { FeishuInboxService } from './feishu-inbox.service';
import { FeishuLinkService } from './feishu-link.service';
import { FeishuOutbound } from './feishu-outbound';
import { FeishuRouter } from './feishu-router';

/**
 * The Feishu bot integration (docs/feishu-bot-design.md): each account's own Feishu (Lark) app, and the
 * administrators' switch for them; every replica's long connection of every app (FeishuLinkService), the inbound inbox
 * (FeishuInboxService), the router its events go through (FeishuRouter), and the outbound client (FeishuOutbound).
 */
@Module({
  controllers: [FeishuController, FeishuAdminController],
  // AdminRoleGuard depends only on the global PrismaService, so it is provided here too (UsersModule does not export it).
  providers: [FeishuAppService, AdminRoleGuard, FeishuRouter, FeishuInboxService, FeishuLinkService, FeishuOutbound],
  exports: [FeishuAppService, FeishuOutbound],
})
export class FeishuModule {}
