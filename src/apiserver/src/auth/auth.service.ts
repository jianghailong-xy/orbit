import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hashPassword, verifyPassword } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.tokenFor(user.id, user.email, user.name);
  }

  /** Whether the deployment still has zero users — drives the web's first-run /setup flow. */
  async getSetupStatus() {
    const count = await this.prisma.user.count();
    return { needsSetup: count === 0 };
  }

  /**
   * First-run setup: create the very first user and return a session token so the
   * browser is logged straight in. Only works while the system has zero users — that
   * zero-user check is the sole gate (trust-on-first-use): the first caller to reach
   * /setup becomes the deployment's ADMIN.
   */
  async bootstrap(email: string, name: string | undefined, password: string) {
    // Closes the door the moment an account exists; a later caller reliably hits this.
    if ((await this.prisma.user.count()) > 0) {
      throw new ConflictException('setup already completed');
    }
    const finalName = name?.trim() || email.split('@')[0];
    // The first user is the deployment's operator, so seed them as ADMIN — the fresh-install
    // counterpart to migration 0040, which promotes the earliest account on an *existing*
    // deployment. Without this, a new install's first user would default to MEMBER and be
    // locked out of the admin area (and thus unable to add anyone else).
    const user = await this.prisma.user.create({
      data: {
        email: email.trim(),
        name: finalName,
        passwordHash: hashPassword(password),
        role: 'ADMIN',
      },
    });
    return this.tokenFor(user.id, user.email, user.name);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // Wrong current password returns 400, not 401: the web client treats any 401 as an
    // expired session and force-logs-out, which must not happen while filling this form.
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      throw new BadRequestException('current password is incorrect');
    }
    if (verifyPassword(newPassword, user.passwordHash)) {
      throw new BadRequestException('new password must be different from the current password');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(newPassword) },
    });
    return { success: true };
  }

  private async tokenFor(userId: string, email: string, name: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, email });
    return { accessToken, user: { id: userId, email, name } };
  }
}
