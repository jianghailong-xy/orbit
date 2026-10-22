import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { DisabledAccounts } from '../auth/disabled-accounts';
import { GoogleLoginService } from '../auth/google-login.service';
import { Impersonation, USER_IMPERSONATED_ACTIVITY } from '../auth/impersonation';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { PatService } from '../auth/pat.service';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRoleGuard } from './admin-role.guard';
import { CreateUserDto, ImpersonateDto, SetDisabledDto, UpdateRoleDto } from './dto';
import { SIGN_IN_METHODS_SELECT, signInMethodsOf } from './sign-in-methods';
import { createOrResetUser } from './users.util';

/** The Activity rows of an account disabled and enabled again (docs/google-sign-in-design.md §5.5): the administrator's. */
export const USER_DISABLED_ACTIVITY = 'user.disabled';
export const USER_ENABLED_ACTIVITY = 'user.enabled';

/**
 * The administrators who can still sign in — what "the last admin" counts (§5.5): a disabled
 * administrator administers nothing.
 */
const ENABLED_ADMINS = { role: 'ADMIN', disabledAt: null } satisfies Prisma.UserWhereInput;

/**
 * When an account last used Orbit, and through what: the latest of its apps' requests — `client_version`,
 * written at most hourly per app, so it can trail by up to an hour — and its access tokens' uses. Null when it
 * has used neither. An administrator viewing Orbit as the account is neither (ClientVersionInterceptor).
 */
export function lastActiveOf(
  apps: Array<{ kind: string; lastSeenAt: Date }>,
  tokens: Array<{ lastUsedAt: Date | null }>,
): { at: Date; via: string } | null {
  let last: { at: Date; via: string } | null = null;
  for (const app of apps) if (!last || app.lastSeenAt > last.at) last = { at: app.lastSeenAt, via: app.kind };
  for (const token of tokens) if (token.lastUsedAt && (!last || token.lastUsedAt > last.at)) last = { at: token.lastUsedAt, via: 'token' };
  return last;
}

/**
 * Role-gated operator area: managing user accounts from the web UI. Every route needs
 * a signed-in ADMIN — JwtAuthGuard sets the user, AdminRoleGuard checks the role per
 * request.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pats: PatService,
    private readonly google: GoogleLoginService,
    // AuthModule provides it everywhere. Without it (a test harness) there is no set to read again.
    @Optional() private readonly disabledAccounts?: DisabledAccounts,
    // AuthModule provides it everywhere. A test harness without it never views another account.
    @Optional() private readonly impersonation?: Impersonation,
  ) {}

  /**
   * Every account, oldest first, each with how it signs in, when it was disabled, null while it is
   * not (docs/google-sign-in-design.md §6), when it last used Orbit (`lastActiveOf`), and when its
   * profile photo was set — the version the list fetches it by (`users/:id/avatar`), null while it
   * has none, as on `me`.
   */
  @Get('users')
  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        disabledAt: true,
        avatar: { select: { updatedAt: true } },
        ...SIGN_IN_METHODS_SELECT,
        clientVersions: { select: { kind: true, lastSeenAt: true } },
        personalAccessTokens: { where: { lastUsedAt: { not: null } }, orderBy: { lastUsedAt: 'desc' }, take: 1, select: { lastUsedAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return users.map(({ avatar, passwordHash, identities, clientVersions, personalAccessTokens, ...user }) => ({
      ...user,
      avatarUpdatedAt: avatar?.updatedAt ?? null,
      signInMethods: signInMethodsOf({ passwordHash, identities }),
      lastActive: lastActiveOf(clientVersions, personalAccessTokens),
    }));
  }

  /**
   * An account's profile photo, as its bytes: what the list draws in the account's avatar, fetched by
   * the `avatarUpdatedAt` its row answers — with the administrator's token, as `users/me/avatar` is
   * with the account's own. 404 while the account has none.
   */
  @Get('users/:id/avatar')
  async userAvatar(@Param('id', PublicIdPipe) id: string): Promise<StreamableFile> {
    const photo = await this.prisma.userAvatar.findUnique({
      where: { userId: id },
      select: { mimeType: true, data: true },
    });
    if (!photo) throw new NotFoundException('no profile photo');
    return new StreamableFile(photo.data, { type: photo.mimeType, disposition: 'inline', length: photo.data.length });
  }

  /** Create a user, or reset an existing one's password (force). Returns the generated
   *  password once when none was supplied — the admin shows it to the new user. */
  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return createOrResetUser(this.prisma, dto);
  }

  @Patch('users/:id/role')
  async setRole(@Param('id', PublicIdPipe) id: string, @Body() dto: UpdateRoleDto) {
    // Never let the last admin be demoted — that would lock everyone out of this area. A disabled
    // admin is not counted: it cannot sign in to this area either.
    if (dto.role !== 'ADMIN') {
      const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true, disabledAt: true } });
      if (target?.role === 'ADMIN' && target.disabledAt === null) {
        const admins = await this.prisma.user.count({ where: ENABLED_ADMINS });
        if (admins <= 1) throw new BadRequestException('cannot demote the last admin');
      }
    }
    return this.prisma.user.update({
      where: { id },
      data: { role: dto.role },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
  }

  @Delete('users/:id')
  async deleteUser(@CurrentUser() me: AuthUser, @Param('id', PublicIdPipe) id: string) {
    if (id === me.userId) throw new BadRequestException('you cannot delete your own account');
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true, disabledAt: true } });
    if (!target) return { id, deleted: false };
    if (target.role === 'ADMIN' && target.disabledAt === null) {
      const admins = await this.prisma.user.count({ where: ENABLED_ADMINS });
      if (admins <= 1) throw new BadRequestException('cannot delete the last admin');
    }
    try {
      await this.prisma.user.delete({ where: { id } });
    } catch {
      // Owned runners/workspaces/sessions/tasks hold FK references; Prisma throws rather
      // than cascade-delete. Surface a clear reason instead of a 500.
      throw new ConflictException('user still owns runners, workspaces, or tasks — remove those first');
    }
    return { id, deleted: true };
  }

  /**
   * Disable an account, or enable it again (docs/google-sign-in-design.md §5.5). Disabling revokes
   * every refresh token it holds; its personal access tokens are kept, refused while it is disabled.
   * Enabling deletes its refresh tokens instead, so a device still holding one is told the token is
   * unknown and signs in again, rather than tripping the reuse detection a revoked token would. Nothing
   * the account owns is touched either way. Refused for the administrator's own account and for the
   * last administrator not disabled. An account already as asked is answered as it is, and nothing is
   * written. Recorded in Activity as this administrator's; this server refuses or admits the account's
   * tokens at once, every other within 30 seconds.
   */
  @Patch('users/:id/disabled')
  async setDisabled(@CurrentUser() admin: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: SetDisabledDto) {
    if (dto.disabled && id === admin.userId) throw new BadRequestException('you cannot disable your own account');
    const target = await this.prisma.user.findUnique({ where: { id }, select: { email: true, role: true, disabledAt: true } });
    if (!target) throw new NotFoundException('user not found');
    if (dto.disabled && target.role === 'ADMIN' && target.disabledAt === null) {
      const admins = await this.prisma.user.count({ where: ENABLED_ADMINS });
      if (admins <= 1) throw new BadRequestException('cannot disable the last admin');
    }
    const user = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id, disabledAt: dto.disabled ? null : { not: null } },
        data: { disabledAt: dto.disabled ? new Date() : null },
      });
      if (count === 1) {
        if (dto.disabled) await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        else await tx.refreshToken.deleteMany({ where: { userId: id } });
        await tx.activity.create({
          data: {
            actorId: admin.userId,
            type: dto.disabled ? USER_DISABLED_ACTIVITY : USER_ENABLED_ACTIVITY,
            payload: { userId: id, email: target.email },
            credentialKind: 'LOGIN',
          },
        });
      }
      return tx.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true, role: true, createdAt: true, disabledAt: true },
      });
    });
    await this.disabledAccounts?.reload();
    return user;
  }

  /**
   * View Orbit as another account, to debug what it sees (auth/impersonation.ts): an access token that
   * reads as that account and writes nothing, for IMPERSONATION_TTL_SECONDS, with no refresh token.
   * Never the administrator's own account, another administrator's or a disabled one. The reason is
   * required, and recorded in Activity with the account as this administrator's before the token is
   * answered.
   */
  @Post('users/:id/impersonate')
  async impersonate(@CurrentUser() admin: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: ImpersonateDto) {
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('a reason is required');
    if (id === admin.userId) throw new BadRequestException('you cannot view Orbit as yourself');
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true, disabledAt: true } });
    if (!target) throw new NotFoundException('user not found');
    if (target.role === 'ADMIN') throw new BadRequestException('you cannot view Orbit as another administrator');
    if (target.disabledAt !== null) throw new BadRequestException('this account is disabled');
    const { accessToken, expiresAt } = await this.impersonation!.issue(admin.userId, target);
    await this.prisma.activity.create({
      data: {
        actorId: admin.userId,
        type: USER_IMPERSONATED_ACTIVITY,
        payload: { userId: id, email: target.email, reason, expiresAt: expiresAt.toISOString() },
        credentialKind: 'LOGIN',
      },
    });
    return { accessToken, expiresAt, user: { id: target.id, email: target.email, name: target.name } };
  }

  /** A user's personal access tokens, as their own list shows them (§11.4). Never the token itself:
   *  it is not kept. */
  @Get('users/:id/access-tokens')
  async listAccessTokens(@Param('id', PublicIdPipe) id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException('user not found');
    return { tokens: await this.pats.list(id) };
  }

  /** Revoke one of a user's tokens at once, recorded as revoked by an administrator. Idempotent. */
  @Delete('users/:id/access-tokens/:tokenId')
  revokeAccessToken(@Param('id', PublicIdPipe) id: string, @Param('tokenId', PublicIdPipe) tokenId: string) {
    return this.pats.revoke(id, tokenId, 'ADMIN');
  }

  /**
   * Unlink a user's Google account (docs/google-sign-in-design.md §5.3) — anyone's, an account without
   * a password included, which a password reset then lets back in. Recorded as this administrator's.
   * Answers the user's `signInMethods`; nothing linked is answered as it is.
   */
  @Delete('users/:id/identities/google')
  unlinkGoogle(@CurrentUser() admin: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.google.unlinkByAdmin(admin.userId, id);
  }
}
