import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { DriveChat } from './drive-chat';
import { DriveChatController } from './drive-chat.controller';
import { DriveSyncFix } from './drive-sync-fix';
import { DriveSyncsService } from './drive-syncs.service';

/**
 * The Drive chat's door (drive-chat.ts): a module of its own, as the wiki chat's is (wiki/wiki-chat.module.ts), because a
 * chat is made through SessionsService.create and DriveModule injects nothing from Sessions.
 */
@Module({
  imports: [SessionsModule],
  controllers: [DriveChatController],
  // DriveSyncsService holds no state: this module's copy reads the same rows as DriveModule's.
  providers: [DriveChat, DriveSyncFix, DriveSyncsService],
})
export class DriveChatModule {}
