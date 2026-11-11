import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { UpdateEmailSettingsDto } from './dto';
import { resendWelcome } from './email-outbox';
import { EmailSettingsService } from './email-settings.service';

/** Said when an administrator asks for a welcome email while the channel is off (§3.5). */
export const EMAIL_NOT_CONFIGURED = 'Email is not configured on this deployment';

/**
 * Admin → Email (docs/welcome-email-design.md §3.1, §3.5): the outgoing email setting, a test email,
 * and sending one account's welcome email again. Gated like the rest of the admin area. The Resend key
 * goes in and never comes back out.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin')
export class AdminEmailController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: EmailSettingsService,
  ) {}

  @Get('email')
  get() {
    return this.settings.view();
  }

  /** Saves the whole setting. A body without `apiKey` keeps the saved one. */
  @Put('email')
  update(@CurrentUser() admin: AuthUser, @Body() dto: UpdateEmailSettingsDto) {
    return this.settings.update(admin.userId, dto);
  }

  /** Sends a test email to the administrator asking, and answers what Resend said. */
  @Post('email/test')
  @HttpCode(200)
  test(@CurrentUser() admin: AuthUser) {
    return this.settings.sendTest(admin.email);
  }

  /** The ⋯ menu's Send welcome email: a FAILED or SKIPPED welcome back to PENDING. */
  @Post('users/:id/welcome-email')
  @HttpCode(200)
  async resend(@Param('id', PublicIdPipe) id: string) {
    if (!(await this.settings.channel())) throw new ConflictException(EMAIL_NOT_CONFIGURED);
    const row = await resendWelcome(this.prisma, id);
    if (!row) throw new NotFoundException('this account has no welcome email');
    return row;
  }
}
