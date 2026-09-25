import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import {
  BindWikiWorkspaceDto,
  CreateWikiSpaceDto,
  UpdateWikiSpaceDto,
  WikiDecideDto,
  WikiProposeDto,
} from './dto';
import { flagParam, listParam, WikiRetrieval } from './wiki-retrieval';
import { answerFor, WikiService, type WikiPrincipal } from './wiki.service';

/**
 * The user door: `/api/wiki/*`, the account owner and nobody else (design §5.1, contract
 * `agentSurface.doors.user`).
 *
 * DECIDING LIVES HERE AND NOWHERE ELSE. `POST /wiki/changesets/:id/decide` refuses every request that
 * carries a session header, whatever that session's role, and the runner door has no decide route at
 * all — the two locks are on the same door on purpose (contract `agentSurface.decide`; the precedent
 * is `refuseSessionAuthoredConfirmation` in `projects/coordinator-authority.ts`).
 *
 * The owner is taken from the credential, never from a body or a query: every id below is an address
 * of one of this account's own rows, and another account's is a plain 404.
 *
 * The topic view and the timeline are here (the two contract routes the pages read); pin/unpin is
 * still not, and it is the one wiki write this door will have whose outcome is not a decision: an
 * entry's `pinned` flag is the owner arranging their own home page, and it is read by no push rule.
 */
@UseGuards(JwtAuthGuard)
@Controller('wiki')
export class WikiController {
  constructor(
    private readonly wiki: WikiService,
    private readonly retrieval: WikiRetrieval,
  ) {}

  /**
   * What ⌘K calls (design §6, contract `agentSurface.doors.user`): entries only, each saying which
   * legs found it.
   *
   * A STATIC ROUTE, and it sits above every `:id` route in this class deliberately: Nest matches in
   * declaration order, so a `search` that came after `entries/:id` would be read as an entry whose
   * id is the word "search".
   *
   * The reader is the owner, which is what decides what is visible: the statuses asked for, active
   * by default. `space` is the space in scope and is checked as the owner's own before it is used —
   * another account's space is the same 404 every other route here answers with; leave it out and
   * the search spans every space this owner has.
   */
  @Get('search')
  async search(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('space', PublicIdPipe) space?: string,
    @Query('kind') kind?: string | string[],
    @Query('topic') topic?: string,
    @Query('trust') trust?: string | string[],
    @Query('status') status?: string | string[],
    @Query('paths') paths?: string | string[],
    @Query('limit') limit?: string,
    @Query('semantic') semantic?: string,
    @Query('include') include?: string,
  ) {
    if (space) await this.wiki.requireSpace(user.userId, space);
    return this.retrieval.search({
      ownerId: user.userId,
      spaceId: space ?? null,
      q,
      kinds: listParam(kind),
      topic: topic?.trim() || undefined,
      trust: listParam(trust),
      statuses: listParam(status),
      paths: listParam(paths),
      limit: limit === undefined ? undefined : Number(limit),
      semantic: flagParam(semantic),
      include: listParam(include),
    });
  }

  /** The owner's spaces, each with the pending count the sidebar shows. */
  @Get('spaces')
  listSpaces(@CurrentUser() user: AuthUser) {
    return this.wiki.listSpaces(user.userId);
  }

  /** A space the owner creates outright: a codebase, or a wiki with no repository behind it. */
  @Post('spaces')
  createSpace(@CurrentUser() user: AuthUser, @Body() dto: CreateWikiSpaceDto) {
    return this.wiki.createSpace(user.userId, dto);
  }

  /**
   * One space. `?include=usage` adds the rolling window the home page's "Agents used the wiki" block
   * reads — the four aggregates over `wiki_exposure` that no other read of the document pays for
   * (see `WikiService.getSpaceView`).
   */
  @Get('spaces/:id')
  getSpace(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('include') include?: string,
  ) {
    return this.wiki.getSpaceView(user.userId, id, {
      usage: askedFor(include).has('usage'),
    });
  }

  /**
   * The space a session's workspace is bound to — what Add to Wiki files into, and the topics its
   * form offers.
   *
   * RESOLVED BY THE SESSION'S OWN RULE, deliberately: this is `resolveSpaceForCall`, the same call a
   * `wiki_propose` from that session goes through, so the owner adding a note from a conversation and
   * the agent that conversation is running land in one codebase's wiki. The alternative — the client
   * picking a space out of the owner's list — is how a note about one repository comes to be filed
   * under another, and it would have no way to tell that it had.
   *
   * A GET that can create a space, which is a real thing to do here: a workspace with a repository
   * URL binds on first use (`bindOnFirstUse`), which is what makes an Add to Wiki in a brand-new
   * workspace work rather than refusing with instructions to go and configure something. The runner
   * door's `GET runner/wiki/search` resolves the same way for the same reason.
   *
   * Two segments deep, so it is not a space the route below could answer for: `spaces/:id` has two
   * segments and this has three, and no space id is the word `for-session`.
   */
  @Get('spaces/for-session/:id')
  async spaceForSession(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    const spaceId = await this.wiki.resolveSpaceForCall(user.userId, id, null);
    return this.wiki.getSpaceView(user.userId, spaceId, { usage: false });
  }

  /** What the space does on its own: whether it pushes, and whether a reinforce applies at once. */
  @Patch('spaces/:id')
  updateSpace(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateWikiSpaceDto) {
    return this.wiki.updateSpace(user.userId, id, dto);
  }

  /** Bind a workspace this space's sessions read and propose through (§2.1's manual binding). */
  @Post('spaces/:id/workspaces')
  @HttpCode(HttpStatus.OK)
  bindWorkspace(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: BindWikiWorkspaceDto) {
    return this.wiki.bindWorkspace(user.userId, id, dto.workspaceId);
  }

  @Get('spaces/:id/entries')
  listEntries(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.wiki.listEntries(user.userId, id, { kind, status, limit: limit ? Number(limit) : undefined });
  }

  /**
   * One topic's page: the entries that carry the topic's slug, newest change first. See
   * `WikiService.getTopicView` for why the name is derived from the slug.
   *
   * A `:slug`, not a `PublicIdPipe`: a topic is named by the same slug pattern a space is
   * (`WIKI_SLUG_PATTERN`), and it is not a row this door could hand back an id for.
   */
  @Get('spaces/:id/topics/:slug')
  getTopic(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('slug') slug: string,
  ) {
    return this.wiki.getTopicView(user.userId, id, slug);
  }

  /** What changed in this space lately, newest first — the home page's timeline. */
  @Get('spaces/:id/timeline')
  timeline(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    const asked = Number(limit);
    return this.wiki.getTimeline(user.userId, id, Number.isFinite(asked) && asked >= 1 ? asked : undefined);
  }

  /** One entry, with the sources of its current revision, its history, and who was shown it. */
  @Get('entries/:id')
  getEntry(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Query('include') include?: string) {
    const asked = askedFor(include);
    return this.wiki.getEntry(user.userId, id, {
      sources: asked.has('sources'),
      history: asked.has('history'),
      exposure: asked.has('exposure'),
    });
  }

  /** What waits for the owner, newest first, across every space or one of them. */
  @Get('review')
  review(@CurrentUser() user: AuthUser, @Query('space', PublicIdPipe) space?: string) {
    return this.wiki.listReview(user.userId, space);
  }

  /**
   * The owner's own write, which applies at once (contract `effectPolicy.origins.owner`) — what Add to
   * Wiki and the Review page's Edit both call, and the same entry point an agent's proposal takes.
   */
  @Post('spaces/:id/changesets')
  @HttpCode(HttpStatus.OK)
  async propose(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: WikiProposeDto) {
    const principal: WikiPrincipal = {
      origin: 'owner',
      ownerId: user.userId,
      userId: user.userId,
      sessionId: null,
      toolCallId: null,
    };
    return answerFor(await this.wiki.submitChangeset(principal, id, dto));
  }

  /**
   * The owner's answer to one or more pending ops: accept, edit or reject.
   *
   * `assertOwnerChannel` runs before anything is read: a request that carries a session header is
   * refused WIKI_OWNER_CHANNEL_ONLY however it authenticated, because an agent reporting a person's
   * answer is not a person answering.
   */
  @Post('changesets/:id/decide')
  @HttpCode(HttpStatus.OK)
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: WikiDecideDto,
    @Req() request: { headers: Record<string, string | string[] | undefined> },
  ) {
    return this.wiki.decide(user.userId, user.userId, id, dto.decisions, actingSession(request.headers));
  }
}

/** `?include=a,b` as a set, the way both routes that take one read it. */
function askedFor(include: string | undefined): Set<string> {
  return new Set((include ?? '').split(',').map((part) => part.trim()).filter(Boolean));
}

/**
 * The calling session a decide arrived with, if any. Scanned by PREFIX rather than by the two header
 * names in use today: `X-Orbit-Session-Id`, `X-Orbit-Session-Token` and whatever a later credential
 * adds are one family, and a decide that carried any of them is a session's.
 */
export function actingSession(headers: Record<string, string | string[] | undefined>): string | null {
  const name = Object.keys(headers).find((header) => header.toLowerCase().startsWith('x-orbit-session-'));
  if (!name) return null;
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
