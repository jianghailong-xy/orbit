import { Module } from '@nestjs/common';
import { AdminRoleGuard } from './admin-role.guard';
import { AdminController } from './admin.controller';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController, AdminController],
  providers: [AdminRoleGuard],
})
export class UsersModule {}
