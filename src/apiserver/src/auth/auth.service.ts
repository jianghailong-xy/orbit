import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { generateToken, hashPassword, sha256, verifyPassword } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

/** Refresh-token lifetime (sliding — each rotation issues a fresh one with a new window). */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

  /**
   * Swap a valid refresh token for a fresh access+refresh pair (rotation). The presented token
   * is consumed atomically; replaying an already-consumed token signals theft, so the user's
   * whole refresh-token family is revoked and the call fails (forcing a real re-login).
   */
  async refresh(refreshToken: string) {
    const tokenHash = sha256(refreshToken);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row) throw new UnauthorizedException('invalid refresh token');
    if (row.revokedAt) {
      // A consumed/revoked token replayed → treat as theft: revoke every live token for the user.
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('refresh token reuse detected');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('refresh token expired');
    }
    // Atomically consume the presented token; a concurrent double-submit that lost the race
    // sees count 0 and is rejected without minting a second token.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw new UnauthorizedException('invalid refresh token');
    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user) throw new UnauthorizedException('invalid refresh token');
    return this.tokenFor(user.id, user.email, user.name);
  }

  /** Revoke a refresh token (sign-out). Idempotent: an unknown/already-revoked token is a no-op. */
  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  private async tokenFor(userId: string, email: string, name: string) {
    const accessToken = await this.jwt.signAsync({ sub: userId, email });
    const refreshToken = await this.issueRefreshToken(userId);
    return { accessToken, refreshToken, user: { id: userId, email, name } };
  }

  /** Mint a fresh opaque refresh token, persist only its hash, and return the plaintext (shown once). */
  private async issueRefreshToken(userId: string): Promise<string> {
    const token = generateToken(32);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return token;
  }
}
