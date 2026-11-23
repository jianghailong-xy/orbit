import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
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
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UploadedFile } from '../attachments/attachments.media';
import { AVATAR_MAX_BYTES, readAvatar } from './avatar';
import { UpdatePreferencesDto, UpdateProfileDto } from './dto';
import { SIGN_IN_METHODS_SELECT, signInMethodsOf } from './sign-in-methods';
import { normalizeDefaultModels } from '../providers/engine-provider';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { senderClientColumns, senderClientOfRequest } from '../sessions/turn-sender-client';
import { changedByOf, mergePreferences, recordDefaultPermissionModeChange, withChangedBy, type SettingChangedBy } from './preferences-merge';
import { translationAvailable, translationUnavailableUntil } from '../sessions/translation';
import { promptOptimizerAvailable } from '../sessions/prompt-optimizer';

/** What every answer about one's own account reads: the account, when its photo was set, and how
 *  it signs in. */
const ME_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  preferences: true,
  role: true,
  avatar: { select: { updatedAt: true } },
  ...SIGN_IN_METHODS_SELECT,
} satisfies Prisma.UserSelect;

/** The account as `me` answers with it. `avatarUpdatedAt` is the photo's version — what a client
 *  fetches and caches it by — and null while the account has none. `signInMethods` says whether it
 *  has a password and which Google account it is linked to (docs/google-sign-in-design.md §6); the
 *  password hash it is read from is not answered. */
function asMe<T extends { avatar?: { updatedAt: Date } | null; passwordHash: string | null; identities: Array<{ email: string }> }>(
  account: T,
) {
  const { avatar, passwordHash, identities, ...rest } = account;
  return {
    ...rest,
    avatarUpdatedAt: avatar?.updatedAt ?? null,
    signInMethods: signInMethodsOf({ passwordHash, identities }),
    // Whether the server can translate at all (MeTranslation, @orbit/shared translation.ts): without its
    // DeepSeek key Settings › Translation is drawn disabled with the board frame 2 notice.
    translationAvailable: translationAvailable(),
    // Set while this process's translator circuit breaker skips a failing translator (board frame 6): the composer
    // tag reads "unavailable, messages will wait" until then.
    translationUnavailableUntil: translationUnavailableUntil()?.toISOString() ?? null,
    // Whether the server can optimize a draft (MePromptOptimizer, @orbit/shared prompt-optimizer.ts): without its
    // DeepSeek key the Prompt optimizer switch is drawn disabled with the board frame 1b notice.
    promptOptimizerAvailable: promptOptimizerAvailable(),
  };
}

@PatForbidden('ACCOUNT')
@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly prisma: PrismaService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const account = await this.prisma.user.findUnique({ where: { id: user.userId }, select: ME_SELECT });
    return account && this.answer(account);
  }

  /**
   * The account as `me` answers with it, with `changedBy`: each setting last changed from a conversation's card
   * (docs/settings-from-conversation-design.md §5.3) with that conversation's title, which the Settings row names it by.
   * A session since deleted reads with a null title.
   */
  private async answer(account: Prisma.UserGetPayload<{ select: typeof ME_SELECT }>) {
    const marks = changedByOf((account.preferences ?? {}) as Record<string, unknown>);
    const sessionIds = [...new Set(Object.values(marks).map((mark) => mark.sessionId))];
    const sessions = sessionIds.length === 0 ? [] : await this.prisma.session.findMany({
      where: { id: { in: sessionIds }, ownerId: account.id, deletedAt: null },
      select: { id: true, title: true },
    });
    const titles = new Map(sessions.map((session) => [session.id, session.title]));
    const changedBy: Record<string, SettingChangedBy & { sessionTitle: string | null }> = {};
    for (const [key, mark] of Object.entries(marks)) changedBy[key] = { ...mark, sessionTitle: titles.get(mark.sessionId) ?? null };
    return { ...asMe(account), changedBy };
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
    return this.answer(await this.prisma.user.update({
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
  async updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePreferencesDto,
    @Headers('x-orbit-client') client?: string,
    @Headers('x-orbit-device') device?: string,
  ) {
    const values: Record<string, unknown> = { ...dto };
    if (dto.defaultModels !== undefined) {
      // Keyed by (engine, provider) — `<engine>:<provider>` — and an older client's own keys kept as it
      // wrote them, beside the new key each means (docs/provider-engine-contract.md §6.5).
      values.defaultModels = await normalizeDefaultModels(this.prisma, user.userId, dto.defaultModels);
    }
    const sender = senderClientColumns(senderClientOfRequest(user.credential, client, device));
    const account = await withTransactionRetry(this.prisma, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ preferences: Prisma.JsonValue }>>`
        SELECT "preferences" FROM "user" WHERE "id" = ${user.userId}::uuid FOR NO KEY UPDATE`;
      const current = (row?.preferences ?? {}) as Record<string, unknown>;
      const { merged, written } = mergePreferences(current, values);
      // Settings changed directly by the owner lose their conversation-card mark.
      const preferences = withChangedBy(merged, written);
      const updated = await tx.user.update({
        where: { id: user.userId },
        data: { preferences: preferences as Prisma.InputJsonValue },
        select: ME_SELECT,
      });
      await recordDefaultPermissionModeChange(tx, user.userId, current, preferences, sender);
      return updated;
    }, loggedRetry(this.logger, 'users.updatePreferences'));
    return this.answer(account);
  }
}
