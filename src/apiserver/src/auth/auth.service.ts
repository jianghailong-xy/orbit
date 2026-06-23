import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'crypto';
import { hashPassword, verifyPassword } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
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
   * browser is logged straight in. Only works while the system has zero users, and
   * (chosen security model) requires the deploy-time ADMIN_TOKEN — the same shared
   * secret that guards POST /users. Validated here rather than via AdminAuthGuard so a
   * wrong token returns 400, not 401: the web client force-logs-out on any 401, which
   * would bounce the operator off the /setup form (see changePassword for the same reason).
   */
  async bootstrap(
    adminToken: string | undefined,
    email: string,
    name: string | undefined,
    password: string,
  ) {
    // Closes the door the moment an account exists; a later caller reliably hits this.
    // (Two simultaneous first-setup requests both carry the token — i.e. a trusted
    // operator — so we don't add a transaction just to serialize that harmless race.)
    if ((await this.prisma.user.count()) > 0) {
      throw new ConflictException('setup already completed');
    }
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected) {
      throw new BadRequestException(
        'ADMIN_TOKEN is not set on the server; configure it to enable first-user setup',
      );
    }
    if (!adminToken || !safeEqual(adminToken, expected)) {
      throw new BadRequestException('invalid admin token');
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

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
