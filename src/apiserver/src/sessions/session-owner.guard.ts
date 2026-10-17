import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { toUuid } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Refuses a session the caller does not have before its handler runs — for the event stream, whose
 * own check cannot refuse in time: a stream's 200 is on the wire before the handler has read
 * anything, so that check's refusal arrives as an `error` frame inside a 200. Here it is the 403
 * the stream's check gives, as a status (the tenant isolation census, docs/google-sign-in-design.md
 * §11 T1). Runs after JwtAuthGuard, which sets the user; an `:id` that is no id at all is left to
 * PublicIdPipe's 400.
 */
@Injectable()
export class SessionOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser; params?: Record<string, string> }>();
    let id: string;
    try {
      id = toUuid(req.params?.id ?? '');
    } catch {
      return true;
    }
    const ownerId = req.user?.userId;
    const own = ownerId ? await this.prisma.session.findFirst({ where: { id, ownerId }, select: { id: true } }) : null;
    if (!own) throw new ForbiddenException('session not found');
    return true;
  }
}
