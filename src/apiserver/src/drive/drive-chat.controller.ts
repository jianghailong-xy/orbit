import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DRIVE_CHAT_RULES, type DriveChatListPage } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { actingSession } from '../wiki/wiki.controller';
import { DRIVE_PAT } from './drive.controller';
import { DriveChat } from './drive-chat';
import { DRIVE_ROUTE_PREFIXES } from './drive-routes';
import { DriveEnabledGuard } from './drive-switch';

/**
 * The owner's Drive chats (drive-chat.ts): making one, and reading them with where a new one runs. Both refuse a request
 * with a session header DRIVE_CHAT_OWNER_CHANNEL_ONLY before anything is read. Making a chat is the owner's interactive
 * credential's alone — a personal access token is refused at the guard, as the wiki chat's create is — and the read
 * takes a token with the drive scope.
 *
 * A chat's later messages are the session's own message door's (`POST /api/sessions/:id/turns`), which takes a Drive
 * chat's `driveContext: { folderId, entryIds }`.
 */
@UseGuards(JwtAuthGuard, DriveEnabledGuard)
@Controller(DRIVE_ROUTE_PREFIXES)
export class DriveChatController {
  constructor(private readonly chats: DriveChat) {}

  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chats')
  create(
    @CurrentUser() user: AuthUser,
    @Body(PublicIdPipe.forFields('workspaceId', 'attachmentIds')) body: unknown,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    // The pipe hands a blank id through as it came; refused here, it never reaches a uuid column as "".
    const workspaceId = (body as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof workspaceId === 'string' && workspaceId.trim() === '') {
      throw new BadRequestException('workspaceId names one of your workspaces, or is left out for the default');
    }
    const attachmentIds = (body as { attachmentIds?: unknown } | null)?.attachmentIds;
    if (typeof attachmentIds === 'string' && attachmentIds.trim() === '') {
      throw new BadRequestException('attachmentIds is a list of the ids of files the owner uploaded, and a blank one names none');
    }
    return this.chats.create(user.userId, body, actingSession(request.headers), user.credential);
  }

  @DRIVE_PAT()
  @Get('chats')
  list(
    @CurrentUser() user: AuthUser,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
    @Query('q') q?: unknown,
    @Query('offset') offset?: unknown,
    @Query('status') status?: unknown,
  ) {
    return this.chats.list(user.userId, actingSession(request.headers), chatListPage(q, offset, status));
  }
}

/** `?q=`, `?offset=` and `?status=` of a chats read, or a 400 that says what they take. */
function chatListPage(q: unknown, offset: unknown, status: unknown): DriveChatListPage {
  if (q !== undefined && (typeof q !== 'string' || q.length > DRIVE_CHAT_RULES.queryMax)) {
    throw new BadRequestException(`q is words a chat's title holds, at most ${DRIVE_CHAT_RULES.queryMax} characters`);
  }
  if (offset !== undefined && (typeof offset !== 'string' || !/^(?:0|[1-9]\d{0,5})$/u.test(offset))) {
    throw new BadRequestException('offset is how many chats to pass over, a whole number from 0');
  }
  if (status !== undefined && status !== 'open' && status !== 'completed') {
    throw new BadRequestException('status is open or completed, or is left out for both');
  }
  return {
    q: q as string | undefined,
    offset: offset === undefined ? undefined : Number(offset),
    status: status as DriveChatListPage['status'],
  };
}
