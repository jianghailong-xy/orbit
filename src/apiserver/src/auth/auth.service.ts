import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { generateToken, hashPassword, sha256, verifyPassword } from '../common/crypto.util';
import { MANAGED_RUNNER_SIGN_IN, type ManagedRunnerSignIn } from '../managed-runners/managed-runner-sign-in';
import { PrismaService } from '../prisma/prisma.service';
import { PatService } from './pat.service';

/** Refresh-token lifetime (sliding — each rotation issues a fresh one with a new window). */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * What the password login checks an account without a password against (docs/google-sign-in-design.md
 * §5.1): a salt and a key no password derives, so the attempt costs one scrypt and fails exactly as a
 * wrong password does — the same 401, after the same work.
 */
const NO_PASSWORD = `${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly pats: PatService,
    // What a sign-in asks of managed runners; a module graph without them has nothing here.
    @Optional() @Inject(MANAGED_RUNNER_SIGN_IN) private readonly managedRunners?: ManagedRunnerSignIn,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash ?? NO_PASSWORD)) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.completeLogin(user);
  }

  /**
   * The one exit every sign-in leaves by — the password, the first-run bootstrap and a Google ticket
   * (docs/google-sign-in-design.md §9.2) — so they answer alike: the access token, the refresh token
   * and the user, whichever way the person signed in. What has to follow a sign-in, such as the managed
   * runner's provisioning intent (docs/managed-runner-design.md), goes here, after the tokens are
   * issued. A refresh is not a sign-in and does not come through here.
   */
  async completeLogin(user: { id: string; email: string; name: string }) {
    const issued = await this.tokenFor(user.id, user.email, user.name);
    // Off, it returns at once; on, it records intent and never throws, so the session above stands.
    await this.managedRunners?.signedIn(user);
    return issued;
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
    return this.completeLogin(user);
  }

  /**
   * Personal access tokens keep working across a password change unless the person asks to revoke
   * them too (§11.3) — a script should not stop because a password changed. Answers how many tokens
   * this revoked.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string, revokeAccessTokens = false) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // An account without a password signs in with Google only (docs/google-sign-in-design.md §5.4):
    // it has no current password to give, and is told so — a 400, for the reason below. An
    // administrator's password reset gives it one.
    if (user?.passwordHash === null) {
      throw new BadRequestException({
        code: 'PASSWORD_NOT_SET',
        message: 'This account signs in with Google and has no password to change — an administrator can set one',
      });
    }
    // Wrong current password returns 400, not 401: the web client treats any 401 as an
    // expired session and force-logs-out, which must not happen while filling this form.
    if (!user?.passwordHash || !verifyPassword(currentPassword, user.passwordHash)) {
      throw new BadRequestException('current password is incorrect');
    }
    if (verifyPassword(newPassword, user.passwordHash)) {
      throw new BadRequestException('new password must be different from the current password');
    }
    // The tokens before the password: a request that fails between the two has ended the tokens it
    // was asked to and left the old password, which a retry finishes — never a new password with
    // tokens still working that the person meant to end.
    const revokedAccessTokens = revokeAccessTokens ? await this.pats.revokeAll(userId, 'PASSWORD_CHANGED') : 0;
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(newPassword) },
    });
    return { success: true, revokedAccessTokens };
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
