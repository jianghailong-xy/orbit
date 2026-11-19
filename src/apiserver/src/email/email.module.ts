import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { AdminEmailController } from './admin-email.controller';
import { EmailOutboxWorker } from './email-outbox';
import { EmailSettingsService } from './email-settings.service';

/**
 * Outgoing email (docs/welcome-email-design.md): Admin → Email, and the outbox worker that sends the
 * welcome email of a new account through Resend.
 */
@Module({
  controllers: [AdminEmailController],
  providers: [EmailSettingsService, EmailOutboxWorker, AdminRoleGuard],
  exports: [EmailSettingsService],
})
export class EmailModule {}
