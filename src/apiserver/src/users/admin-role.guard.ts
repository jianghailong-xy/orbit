import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Guards the role-gated admin area. Runs after JwtAuthGuard (which sets req.user),
 * then looks the role up per-request from the DB — so a just-promoted or just-demoted
 * user takes effect immediately, without reissuing their token.
 */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.userId;
    if (!userId) throw new ForbiddenException('admin only');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role !== 'ADMIN') throw new ForbiddenException('admin only');
    return true;
  }
}
