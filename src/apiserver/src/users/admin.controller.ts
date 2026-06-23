import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRoleGuard } from './admin-role.guard';
import { CreateUserDto, UpdateRoleDto } from './dto';
import { createOrResetUser } from './users.util';

/**
 * Role-gated operator area: managing user accounts from the web UI. Every route needs
 * a signed-in ADMIN — JwtAuthGuard sets the user, AdminRoleGuard checks the role per
 * request.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('users')
  listUsers() {
    return this.prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Create a user, or reset an existing one's password (force). Returns the generated
   *  password once when none was supplied — the admin shows it to the new user. */
  @Post('users')
  createUser(@Body() dto: CreateUserDto) {
    return createOrResetUser(this.prisma, dto);
  }

  @Patch('users/:id/role')
  async setRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
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
  async deleteUser(@CurrentUser() me: AuthUser, @Param('id') id: string) {
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
      // Owned runners/agents/sessions/tasks hold FK references; Prisma throws rather
      // than cascade-delete. Surface a clear reason instead of a 500.
      throw new ConflictException('user still owns runners, agents, or tasks — remove those first');
    }
    return { id, deleted: true };
  }
}
