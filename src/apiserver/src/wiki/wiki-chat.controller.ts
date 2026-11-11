import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { WIKI_CHAT_LIST_QUERY_MAX, type WikiChatListPage } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { actingSession } from './wiki.controller';
import { WikiChat } from './wiki-chat';
import { WikiChatDrafts } from './wiki-chat-drafts';
import { WikiRolloutGuard } from './wiki-rollout';

/**
 * A space's wiki chats, on the user door (contract `chat.routes`): making one, and reading the space's chats with
 * where they run and the round button's counts. Both refuse a request with a session header WIKI_OWNER_CHANNEL_ONLY
 * before anything is read (`WikiChat`); another owner's space is the plain 404. Making a chat is the owner's
 * interactive credential's alone — a personal access token is refused OWNER_INTERACTIVE_CREDENTIAL_REQUIRED at the
 * guard, as a binding write is — and the read takes a token with wiki:read.
 *
 * A chat's later messages are the session's own message door's (`POST /api/sessions/:id/turns`, contract
 * `chat.turns`), which takes a chat's wikiContext.
 *
 * The cards (contract `chat.drafts.read`) and the six presses (`chat.presses`) are here too, every one the owner's: a
 * request with a session header is refused WIKI_OWNER_CHANNEL_ONLY before anything is read (`WikiChatDrafts`), a press
 * takes only the owner's interactive credential, and a read a token with wiki:read. Another owner's chat or card is the
 * plain 404.
 */
/** An Edit's body (contract `chat.presses.edit`): `{ ops: [{ seq, changes }] }`, held to that shape by `WikiChatDrafts.edit`. No id. */
interface WikiChatEditBody {
  ops?: unknown;
}

@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiChatController {
  constructor(
    private readonly chats: WikiChat,
    private readonly drafts: WikiChatDrafts,
  ) {}

  @PatForbidden('OWNER_INTERACTIVE')
  @Post('spaces/:id/chats')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body(PublicIdPipe.forFields('workspaceId', 'attachmentIds')) body: unknown,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    // The pipe hands a blank id through as it came; refused here, it never reaches a uuid column as "".
    const workspaceId = (body as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof workspaceId === 'string' && workspaceId.trim() === '') {
      throw new BadRequestException('workspaceId names one of the workspaces the space\'s chats may run in, or is left out');
    }
    // The pipe decodes every id the list holds and refuses one it cannot, a blank one included; a blank string in the
    // list's place is no list, and the pipe hands it on as it came. Refused here, as a blank workspaceId is.
    const attachmentIds = (body as { attachmentIds?: unknown } | null)?.attachmentIds;
    if (typeof attachmentIds === 'string' && attachmentIds.trim() === '') {
      throw new BadRequestException('attachmentIds is a list of the ids of files the owner uploaded, and a blank one names none');
    }
    return this.chats.create(user.userId, id, body, actingSession(request.headers), user.credential);
  }

  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('spaces/:id/chats')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
    @Query('q') q?: unknown,
    @Query('offset') offset?: unknown,
  ) {
    return this.chats.list(user.userId, id, actingSession(request.headers), chatListPage(q, offset));
  }

  /** Every card of one chat, oldest first (contract `chat.drafts.read`): `:id` is the chat's session. */
  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('chats/:id/drafts')
  chatDrafts(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.listOfChat(user.userId, id, actingSession(request.headers));
  }

  /** One card (contract `chat.drafts.read`). */
  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('chat-drafts/:id')
  draft(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.read(user.userId, id, actingSession(request.headers));
  }

  /** Apply (contract `chat.presses.apply`): the card's ops recorded and accepted, its Rewrites queued. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chat-drafts/:id/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.apply(user.userId, user.userId, id, actingSession(request.headers));
  }

  /** Edit (contract `chat.presses.edit`): `{ ops: [{ seq, changes }] }` laid over the card's ops, then Apply's. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chat-drafts/:id/edit')
  @HttpCode(HttpStatus.OK)
  edit(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() body: WikiChatEditBody,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.edit(user.userId, user.userId, id, body, actingSession(request.headers));
  }

  /** Discard (contract `chat.presses.discard`): the card marked, nothing else written. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chat-drafts/:id/discard')
  @HttpCode(HttpStatus.OK)
  discard(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.discard(user.userId, user.userId, id, actingSession(request.headers));
  }

  /** Undo (contract `chat.presses.undo`): the Apply reverted and the sections its rewrite wrote restored. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chat-drafts/:id/undo')
  @HttpCode(HttpStatus.OK)
  undo(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.undo(user.userId, user.userId, id, actingSession(request.headers));
  }

  /** Try again (contract `chat.presses.retry`): a failed rewrite's sections queued again. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chat-drafts/:id/retry')
  @HttpCode(HttpStatus.OK)
  retry(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.retry(user.userId, user.userId, id, actingSession(request.headers));
  }

  /** Seen (contract `chat.presses.seen`): the owner opened the card's settled rewrite. */
  @PatForbidden('OWNER_INTERACTIVE')
  @Post('chat-drafts/:id/seen')
  @HttpCode(HttpStatus.OK)
  seen(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.drafts.seen(user.userId, user.userId, id, actingSession(request.headers));
  }
}

/** `?q=` and `?offset=` of a chats read (contract `chat.list.page`), or a 400 that says what they take. */
function chatListPage(q: unknown, offset: unknown): WikiChatListPage {
  if (q !== undefined && (typeof q !== 'string' || q.length > WIKI_CHAT_LIST_QUERY_MAX)) {
    throw new BadRequestException(`q is words a chat's title holds, at most ${WIKI_CHAT_LIST_QUERY_MAX} characters`);
  }
  if (offset !== undefined && (typeof offset !== 'string' || !/^(?:0|[1-9]\d{0,5})$/u.test(offset))) {
    throw new BadRequestException('offset is how many chats to pass over, a whole number from 0');
  }
  return { q: q as string | undefined, offset: offset === undefined ? undefined : Number(offset) };
}
