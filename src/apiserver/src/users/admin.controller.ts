import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { GoogleLoginService } from '../auth/google-login.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { PatService } from '../auth/pat.service';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRoleGuard } from './admin-role.guard';
import { CreateUserDto, UpdateRoleDto } from './dto';
import { SIGN_IN_METHODS_SELECT, signInMethodsOf } from './sign-in-methods';
import { createOrResetUser } from './users.util';

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
  ) {}

  /** Every account, oldest first, each with how it signs in (docs/google-sign-in-design.md §6). */
  @Get('users')
  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, createdAt: true, ...SIGN_IN_METHODS_SELECT },
      orderBy: { createdAt: 'asc' },
    });
    return users.map(({ passwordHash, identities, ...user }) => ({ ...user, signInMethods: signInMethodsOf({ passwordHash, identities }) }));
  }

  /** Create a user, or reset an existing one's password (force). Returns the generated
   *  password once when none was supplied — the admin shows it to the new user. */
  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return createOrResetUser(this.prisma, dto);
  }

  @Patch('users/:id/role')
  async setRole(@Param('id', PublicIdPipe) id: string, @Body() dto: UpdateRoleDto) {
    // Never let the last admin be demoted — that would lock everyone out of this area.
    if (dto.role !== 'ADMIN') {
      const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
      if (target?.role === 'ADMIN') {
        const admins = await this.prisma.user.count({ where: { role: 'ADMIN' } });
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
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!target) return { id, deleted: false };
    if (target.role === 'ADMIN') {
      const admins = await this.prisma.user.count({ where: { role: 'ADMIN' } });
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
