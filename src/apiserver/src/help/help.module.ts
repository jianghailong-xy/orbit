import { Module } from '@nestjs/common';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { HelpReaderGuard, HelpController } from './help.controller';
import { AdminHelpFeedbackController, HelpFeedback, HelpFeedbackController } from './help-feedback';
import { HelpLibrary } from './help-library';

/**
 * The help article library, read from docs/help once at boot: a library that does not parse stops the boot. And the
 * Yes / No its readers give (help-feedback.ts), counted for administrators.
 */
@Module({
  controllers: [HelpController, HelpFeedbackController, AdminHelpFeedbackController],
  providers: [
    HelpReaderGuard,
    HelpFeedback,
    // AdminRoleGuard depends only on the global PrismaService, as queue.module.ts provides it.
    AdminRoleGuard,
    { provide: HelpLibrary, useFactory: () => HelpLibrary.load() },
  ],
  // The Ask answers from the same library (help-ask.module.ts).
  exports: [HelpLibrary],
})
export class HelpModule {}
