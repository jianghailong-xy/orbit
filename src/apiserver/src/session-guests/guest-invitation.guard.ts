import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { toUuid } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { SessionGuestsService } from './session-guests.service';

/**
 * The guest door's one 404 (`GUEST_SESSION_NOT_SHARED`) before the guest's stream runs: a stream's 200 is on the wire
 * before its handler has read anything, so a refusal made there would arrive as an `error` frame inside a 200 (the
 * reason SessionOwnerGuard exists for the owner's stream). Runs after JwtAuthGuard, which sets the user; an `:id`
 * that is no id at all is left to PublicIdPipe's 400.
 */
@Injectable()
export class GuestInvitationGuard implements CanActivate {
  constructor(private readonly guests: SessionGuestsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser; params?: Record<string, string> }>();
    let id: string;
    try {
      id = toUuid(req.params?.id ?? '');
    } catch {
      return true;
    }
    await this.guests.assertInvited(req.user?.userId ?? '', id);
    return true;
  }
}
