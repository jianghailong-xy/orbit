import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { SessionsModule } from '../sessions/sessions.module';
import { FeishuCardActions } from './feishu-card-actions';
import { FeishuModule } from './feishu.module';

/**
 * The Feishu actions that call into the account's sessions (docs/feishu-bot-design.md §7.2): the owner's clicks on
 * cards (FeishuCardActions). A module of its own because FeishuModule cannot import SessionsModule: SessionsModule
 * reaches PushModule (through CoordinatorJudgmentModule), and PushModule imports FeishuModule. This one imports all
 * three and is imported by nothing but AppModule, so there is no ring; FeishuCardActions registers itself with
 * FeishuRouter when the module starts.
 */
@Module({
  imports: [FeishuModule, PushModule, SessionsModule],
  providers: [FeishuCardActions],
})
export class FeishuActionsModule {}
