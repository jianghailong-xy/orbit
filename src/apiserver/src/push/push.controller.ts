import { Body, Controller, Optional, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDeviceTokenDto, UnregisterDeviceTokenDto } from './dto';
import { JudgmentDeliveryService } from './judgment-delivery.service';

/** Device-token registration for APNs push. The sender lives in PushService (see push.service). */
@Controller('push')
export class PushController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly judgments?: JudgmentDeliveryService,
  ) {}

  /**
   * Register (or refresh) this device's APNs token for the current user. Upsert by the unique
   * token so a re-registered device — or one handed to a different user — points at the right
   * owner, without piling up stale rows.
   */
  @UseGuards(JwtAuthGuard)
  @Post('register')
  async register(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceTokenDto) {
    const data = {
      platform: dto.platform ?? 'ios',
      environment: dto.environment ?? 'production',
      bundleId: dto.bundleId,
    };
    await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: { userId: user.userId, token: dto.token, ...data },
      update: { userId: user.userId, ...data },
    });
    // A NO_DEVICES ledger row already has its durable retry instant. Nudge the worker so any due
    // work is picked up now and its next persisted wake is recalculated after this registration.
    this.judgments?.kick();
    return { ok: true };
  }

  /** Drop a device token (e.g. on sign-out). Scoped to the caller so you can only remove your own. */
  @UseGuards(JwtAuthGuard)
  @Post('unregister')
  async unregister(@CurrentUser() user: AuthUser, @Body() dto: UnregisterDeviceTokenDto) {
    await this.prisma.deviceToken.deleteMany({ where: { token: dto.token, userId: user.userId } });
    return { ok: true };
  }
}
