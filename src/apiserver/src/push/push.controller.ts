import { BadRequestException, Body, ConflictException, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDeviceTokenDto, UnregisterDeviceTokenDto } from './dto';

/** Authenticated APNs/FCM registration. Sending is independently configured in PushService. */
@Controller('push')
export class PushController {
  private readonly log = new Logger(PushController.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register the current owner's device. APNs refreshes by token; Android also atomically
   * replaces the installation's previous token and returns a fresh account binding key.
   */
  @UseGuards(JwtAuthGuard)
  @Post('register')
  async register(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceTokenDto) {
    const data = {
      platform: dto.platform ?? 'ios',
      environment: dto.environment ?? 'production',
      bundleId: dto.bundleId,
    };
    if (data.platform === 'android' && (!dto.installationId || data.environment !== 'production')) {
      throw new BadRequestException('Android requires installationId and environment=production');
    }
    // Both unique identities (token and installation) move atomically, including across accounts.
    // A new Android row is also a fresh binding key: queued pushes/logout from the old login expire.
    try {
      return await withTransactionRetry(this.prisma, async (tx) => {
        const existing = await tx.deviceToken.findUnique({ where: { token: dto.token } });
        if (existing && existing.platform !== data.platform) {
          throw new ConflictException('Token is registered to a different push platform');
        }
        if (data.platform === 'android') {
          await tx.deviceToken.deleteMany({
            where: {
              platform: 'android',
              OR: [
                { token: dto.token },
                { bundleId: data.bundleId, environment: data.environment, installationId: dto.installationId },
              ],
            },
          });
          const row = await tx.deviceToken.create({
            data: { userId: user.userId, token: dto.token, ...data, installationId: dto.installationId },
          });
          return { ok: true, registrationKey: row.id };
        }
        await tx.deviceToken.upsert({
          where: { token: dto.token },
          create: { userId: user.userId, token: dto.token, ...data },
          update: { userId: user.userId, ...data },
        });
        return { ok: true };
      }, loggedRetry(this.log, 'push.register', {
        transaction: { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Device registration changed concurrently; register the current token again');
      }
      throw err;
    }
  }

  /** Drop a device token (e.g. on sign-out). Scoped to the caller so you can only remove your own. */
  @UseGuards(JwtAuthGuard)
  @Post('unregister')
  async unregister(@CurrentUser() user: AuthUser, @Body() dto: UnregisterDeviceTokenDto) {
    const platform = dto.platform ?? 'ios';
    if (platform === 'android' && !dto.registrationKey) {
      throw new BadRequestException('Android requires registrationKey');
    }
    await this.prisma.deviceToken.deleteMany({
      where: {
        token: dto.token, userId: user.userId, platform,
        ...(platform === 'android' ? { id: dto.registrationKey } : {}),
      },
    });
    return { ok: true };
  }
}
