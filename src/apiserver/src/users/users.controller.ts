import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePreferencesDto } from './dto';

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { id: true, email: true, name: true, createdAt: true, preferences: true, role: true },
    });
  }

  /**
   * Patch the current user's own preferences. The body is a partial set of keys
   * (theme / new-agent defaults); each present key is shallow-merged into the
   * stored JSON, so omitted keys keep their value. Returns the same shape as `me`.
   */
  @UseGuards(JwtAuthGuard)
  @Patch('me/preferences')
  async updatePreferences(@CurrentUser() user: AuthUser, @Body() dto: UpdatePreferencesDto) {
    const current = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { preferences: true },
    });
    const merged = { ...((current?.preferences ?? {}) as Record<string, unknown>) };
    if (dto.theme !== undefined) merged.theme = dto.theme;
    if (dto.defaultModel !== undefined) merged.defaultModel = dto.defaultModel;
    if (dto.defaultPermissionMode !== undefined) merged.defaultPermissionMode = dto.defaultPermissionMode;
    return this.prisma.user.update({
      where: { id: user.userId },
      data: { preferences: merged as Prisma.InputJsonValue },
      select: { id: true, email: true, name: true, createdAt: true, preferences: true, role: true },
    });
  }
}
