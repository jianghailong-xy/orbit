import { Module, forwardRef } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { FeishuAdminController } from './feishu-admin.controller';
import { FeishuAppService } from './feishu-app.service';
import { FeishuChatRouteService } from './feishu-chat-route.service';
import { FeishuController } from './feishu.controller';
import { FeishuDirectService } from './feishu-direct.service';
import { FeishuInboxService } from './feishu-inbox.service';
import { FeishuLinkService } from './feishu-link.service';
import { FeishuOutbound } from './feishu-outbound';
import { FeishuOutboxService } from './feishu-outbox';
import { FeishuOwnerService } from './feishu-owner.service';
import { FeishuRouter } from './feishu-router';

/**
 * The Feishu bot integration (docs/feishu-bot-design.md): each account's own Feishu (Lark) app, and the
 * administrators' switch for them; every replica's long connection of every app (FeishuLinkService), the inbound inbox
 * (FeishuInboxService), the router its events go through (FeishuRouter), the outbound client (FeishuOutbound), and the
 * outbox a session's replies go back to Feishu through (FeishuOutboxService).
 *
 * The owner's direct messages open sessions and send turns (FeishuDirectService), so this module imports SessionsModule
 * and PushModule; both reach back here (PushModule imports this one for FeishuTransport, SessionsModule through
 * CoordinatorJudgmentModule → PushModule), so the imports are forwardRef, as are the two injections.
 */
@Module({
  imports: [forwardRef(() => SessionsModule), forwardRef(() => PushModule)],
  controllers: [FeishuController, FeishuAdminController],
  // AdminRoleGuard depends only on the global PrismaService, so it is provided here too (UsersModule does not export it).
  providers: [FeishuAppService, AdminRoleGuard, FeishuRouter, FeishuInboxService, FeishuLinkService, FeishuOutbound, FeishuOwnerService, FeishuChatRouteService, FeishuDirectService, FeishuOutboxService],
  // FeishuRouter for the card actions (feishu-actions.module.ts), which register with it.
  exports: [FeishuAppService, FeishuOutbound, FeishuRouter],
})
export class FeishuModule {}
