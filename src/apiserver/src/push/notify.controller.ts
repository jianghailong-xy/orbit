import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { SharedRateLimiter } from '../shared/public-surface.guard';
import { SendNotificationDto } from './dto';
import { PushService, type OwnerNotificationResult } from './push.service';

/**
 * How many notifications one caller may send: `max` in any `windowMs`, counted per access token (per sign-in for a
 * person calling it signed in), in each apiserver. Grafana sends one per alert group, at most every five minutes each, so
 * an alerting system stays far below it; a script in a loop does not, and is answered 429 before anything is sent.
 */
export const NOTIFY_RATE_LIMIT = { max: 20, windowMs: 60_000 };

/**
 * POST /api/notify: anyone holding a personal access token with the `notify` scope pushes a notification to the token
 * owner's Orbit apps on iOS and Android (docs/api-reference.md, "Sending a notification"; docs/self-hosting.md,
 * "Monitoring"). A deployment with no APNs or FCM credentials accepts the call and answers `delivered: false` with
 * PUSH_NOT_CONFIGURED: that is how such a server is, not an error.
 */
@Controller('notify')
export class NotifyController {
  readonly limiter = new SharedRateLimiter(NOTIFY_RATE_LIMIT, 'too many notifications sent with this access token, slow down');

  constructor(private readonly push: PushService) {}

  @UseGuards(JwtAuthGuard)
  @PatScope('notify', { workspaceConfinable: false })
  @Post()
  @HttpCode(HttpStatus.OK)
  async send(@CurrentUser() user: AuthUser, @Body() dto: SendNotificationDto): Promise<OwnerNotificationResult> {
    const credential = user.credential;
    this.limiter.take(credential?.kind === 'PAT' ? `pat:${credential.tokenId}` : `user:${user.userId}`);
    return this.push.notifyOwner(user.userId, {
      title: dto.title.trim(),
      message: dto.message.trim(),
      priority: dto.priority ?? 'normal',
      ...(dto.url ? { url: dto.url } : {}),
    });
  }
}
