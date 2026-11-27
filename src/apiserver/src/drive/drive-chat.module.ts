import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { DriveChat } from './drive-chat';
import { DriveChatController } from './drive-chat.controller';

/**
 * The Drive chat's door (drive-chat.ts): a module of its own, as the wiki chat's is (wiki/wiki-chat.module.ts), because a
 * chat is made through SessionsService.create and DriveModule injects nothing from Sessions.
 */
@Module({
  imports: [SessionsModule],
  controllers: [DriveChatController],
  providers: [DriveChat],
})
export class DriveChatModule {}
