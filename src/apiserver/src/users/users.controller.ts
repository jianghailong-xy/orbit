import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Patch,
  Put,
  StreamableFile,
  UploadedFile as UploadedFileParam,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UploadedFile } from '../attachments/attachments.media';
import { AVATAR_MAX_BYTES, readAvatar } from './avatar';
import { UpdatePreferencesDto, UpdateProfileDto } from './dto';

/** What every answer about one's own account reads: the account, and when its photo was set. */
const ME_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  preferences: true,
  role: true,
  avatar: { select: { updatedAt: true } },
} satisfies Prisma.UserSelect;

/** The account as `me` answers with it. `avatarUpdatedAt` is the photo's version — what a client
 *  fetches and caches it by — and null while the account has none. */
function asMe<T extends { avatar?: { updatedAt: Date } | null }>(account: T) {
  const { avatar, ...rest } = account;
  return { ...rest, avatarUpdatedAt: avatar?.updatedAt ?? null };
}

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const account = await this.prisma.user.findUnique({ where: { id: user.userId }, select: ME_SELECT });
    return account && asMe(account);
  }

  /**
   * Rename the current user: the name every client shows over the account, and the one the people
   * in their shared pools see them by. Trimmed; a name that is blank once trimmed is refused rather
   * than stored, since it would leave the account nameless wherever it is shown. Returns the same
   * shape as `me`.
   */
  @UseGuards(JwtAuthGuard)
  @Patch('me')
  async updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name must not be empty');
    return asMe(await this.prisma.user.update({
      where: { id: user.userId },
      data: { name },
      select: ME_SELECT,
    }));
  }

  /**
   * Set the current user's profile photo: a multipart `file`, cropped square and scaled down by the
   * client, kept whole and typed by what its bytes are. Replaces any photo before it. Returns the
   * same shape as `me`, whose `avatarUpdatedAt` is then the new photo's version.
   */
  @UseGuards(JwtAuthGuard)
  @Put('me/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_BYTES } }))
  async setAvatar(@CurrentUser() user: AuthUser, @UploadedFileParam() file: UploadedFile | undefined) {
    const { mimeType, data } = readAvatar(file);
    const updatedAt = new Date();
    await this.prisma.userAvatar.upsert({
      where: { userId: user.userId },
      create: { userId: user.userId, mimeType, data, updatedAt },
      update: { mimeType, data, updatedAt },
    });
    return this.me(user);
  }

  /** Remove the current user's profile photo, so every client draws the name's first letter again.
   *  Returns the same shape as `me`. */
  @UseGuards(JwtAuthGuard)
  @Delete('me/avatar')
  async removeAvatar(@CurrentUser() user: AuthUser) {
    await this.prisma.userAvatar.deleteMany({ where: { userId: user.userId } });
    return this.me(user);
  }

  /**
   * The current user's profile photo, as its bytes. Bearer-guarded like every read here, so an
   * `<img src>` cannot point at it: a client fetches it with its token, keyed by `avatarUpdatedAt`,
   * and draws it itself. 404 while the account has none.
   */
  @UseGuards(JwtAuthGuard)
  @Get('me/avatar')
  async avatar(@CurrentUser() user: AuthUser): Promise<StreamableFile> {
    const photo = await this.prisma.userAvatar.findUnique({
      where: { userId: user.userId },
      select: { mimeType: true, data: true },
    });
    if (!photo) throw new NotFoundException('no profile photo');
    return new StreamableFile(photo.data, { type: photo.mimeType, disposition: 'inline', length: photo.data.length });
  }

  /**
   * Patch the current user's own preferences. The body is a partial set of keys
   * (theme / new-workspace defaults); each present key is shallow-merged into the
   * stored JSON, so omitted keys keep their value. `defaultModels` also merges its provider
   * entries, keeping choices for other providers. Returns the same shape as `me`.
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
    if (dto.defaultModels !== undefined) {
      merged.defaultModels = {
        ...((merged.defaultModels ?? {}) as Record<string, string>),
        ...dto.defaultModels,
      };
    }
    if (dto.defaultPermissionMode !== undefined) merged.defaultPermissionMode = dto.defaultPermissionMode;
    if (dto.defaultEffort !== undefined) merged.defaultEffort = dto.defaultEffort;
    if (dto.notifySessionFinished !== undefined)
      merged.notifySessionFinished = dto.notifySessionFinished;
    if (dto.notifyAgentMessage !== undefined) merged.notifyAgentMessage = dto.notifyAgentMessage;
    if (dto.enableOrchestration !== undefined) merged.enableOrchestration = dto.enableOrchestration;
    if (dto.modelRouting !== undefined) merged.modelRouting = dto.modelRouting;
    return asMe(await this.prisma.user.update({
      where: { id: user.userId },
      data: { preferences: merged as Prisma.InputJsonValue },
      select: ME_SELECT,
    }));
  }
}
