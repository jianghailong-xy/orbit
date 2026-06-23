import { Module } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminRoleGuard } from './admin-role.guard';
import { AdminController } from './admin.controller';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController, AdminController],
  providers: [AdminAuthGuard, AdminRoleGuard],
})
export class UsersModule {}
