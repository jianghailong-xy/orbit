import { Module } from '@nestjs/common';
import { AdminRoleGuard } from './admin-role.guard';
import { AdminController } from './admin.controller';
import { TranslationStatusAnnouncer } from './translation-status-announcer';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController, AdminController],
  providers: [AdminRoleGuard, TranslationStatusAnnouncer],
})
export class UsersModule {}
