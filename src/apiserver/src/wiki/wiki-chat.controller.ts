import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { actingSession } from './wiki.controller';
import { WikiChat } from './wiki-chat';
import { WikiRolloutGuard } from './wiki-rollout';

/**
 * A space's wiki chats, on the user door (contract `chat.routes`): making one, and reading the space's chats with
 * where they run and the round button's counts. Both refuse a request with a session header WIKI_OWNER_CHANNEL_ONLY
 * before anything is read (`WikiChat`); another owner's space is the plain 404. Making a chat is the owner's
 * interactive credential's alone — a personal access token is refused OWNER_INTERACTIVE_CREDENTIAL_REQUIRED at the
 * guard, as a binding write is — and the read takes a token with wiki:read.
 *
 * A chat's later messages are the session's own message door's (`POST /api/sessions/:id/turns`, contract
 * `chat.turns`), which takes a chat's wikiContext; the cards and the presses are C6's.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiChatController {
  constructor(private readonly chats: WikiChat) {}

  @PatForbidden('OWNER_INTERACTIVE')
  @Post('spaces/:id/chats')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body(PublicIdPipe.forFields('workspaceId')) body: unknown,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    // The pipe hands a blank id through as it came; refused here, it never reaches a uuid column as "".
    const workspaceId = (body as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof workspaceId === 'string' && workspaceId.trim() === '') {
      throw new BadRequestException('workspaceId names one of the workspaces the space\'s chats may run in, or is left out');
    }
    return this.chats.create(user.userId, id, body, actingSession(request.headers), user.credential);
  }

  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/chats')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.chats.list(user.userId, id, actingSession(request.headers));
  }
}
