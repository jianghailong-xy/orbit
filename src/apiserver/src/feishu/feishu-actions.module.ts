import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { FeishuCardActions } from './feishu-card-actions';
import { FeishuModule } from './feishu.module';

/**
 * The owner's clicks on approval cards (FeishuCardActions, docs/feishu-bot-design.md §7.2, §7.4). A module of its own,
 * imported by nothing but AppModule, so it needs no forwardRef of its own: it imports FeishuModule, PushModule (for
 * FeishuTransport) and SessionsModule, and FeishuCardActions registers itself with FeishuRouter when the module starts.
 * The router asks FeishuDirectService first (its default-workspace card) and hands every other click to it.
 */
@Module({
  imports: [FeishuModule, PushModule, SessionsModule],
  providers: [FeishuCardActions],
})
export class FeishuActionsModule {}
