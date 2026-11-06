import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { WikiModule } from './wiki.module';
import { WikiChat } from './wiki-chat';
import { WikiChatController } from './wiki-chat.controller';

/**
 * The wiki chat's door (contract `chat`): a module of its own because a chat is made through SessionsService.create,
 * and WikiModule injects nothing from Sessions (wiki.module.ts says why). Everything else the door reads it reads
 * through Prisma, as the wiki's own services do — but the cards and the presses, which are WikiModule's
 * (`WikiChatDrafts`, writing through the one WikiService and WikiDocs).
 */
@Module({
  imports: [SessionsModule, WikiModule],
  controllers: [WikiChatController],
  providers: [WikiChat],
})
export class WikiChatModule {}
