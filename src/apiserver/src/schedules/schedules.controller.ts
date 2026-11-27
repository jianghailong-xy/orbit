/**
 * The REST doors of scheduled tasks (docs/scheduled-tasks-design.md §9.1): read and control, and the owner's press
 * on the two cards. There is deliberately NO door here that creates or changes a schedule — those go through a
 * session's `schedule_create` / `schedule_update` and its card — with one exception, rename, which changes the title
 * alone (§8.4; `schedules-rest-surface.spec.ts` holds this).
 *
 *   GET    /api/schedules                         list (not ENDED unless ?state=), with the page's timeline runs
 *   GET    /api/schedules/drafts                  the Scheduled page's drafts: PENDING create cards
 *   POST   /api/schedules/drafts                  the quick-add line: a sentence opens an ordinary session
 *   GET    /api/schedules/chat                    the page chat: the open one, and Orbit's opening for a new one
 *   POST   /api/schedules/chat                    the page chat: the person's first words open it (owner channel)
 *   GET    /api/schedules/:id                     the inspector, with this month's use
 *   GET    /api/schedules/:id/runs                runs, newest first
 *   POST   /api/schedules/:id/{pause,resume,run,undo}
 *   POST   /api/schedules/:id/rename              the title alone
 *   DELETE /api/schedules/:id
 *   POST   /api/schedule-runs/:id/stop
 *   GET    /api/schedule-requests[/:id]           the cards
 *   POST   /api/schedule-requests/:id/{allow,decline}   owner channel only
 *   GET    /api/sessions/:id/schedule-cards       what one session put up: its cards and its change records
 *
 * WHO IS ASKING: a personal access token is the person (PAT, recorded USER) and may read and use the controls; it
 * may not press a card (OWNER_INTERACTIVE_CREDENTIAL_REQUIRED). A request carrying an acting session
 * (`X-Orbit-Session-*`) is that session, and a session never presses a card (SCHEDULE_DECISION_OWNER_CHANNEL_ONLY).
 * Neither door is a @TerminalRoute, so `orbit` in a terminal is refused at the guard.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  ConflictException,
} from '@nestjs/common';
import { toUuid } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { SessionsService } from '../sessions/sessions.service';
import { actingSession } from '../wiki/wiki.controller';
import {
  ScheduleChangeDto,
  ScheduleDecisionDto,
  ScheduleDraftDto,
  SchedulePageChatDto,
  ScheduleRenameDto,
  ScheduleUndoDto,
} from './dto';
import { ScheduleChangeConversations } from './schedule-change-conversation';
import { SchedulePageChats } from './schedule-page-chat';
import { assertTimezone } from './schedule-time';
import { ScheduleReadsService } from './schedule-reads.service';
import { ScheduleRunsService } from './schedule-runs.service';
import { scheduleRunView } from './schedule-views';
import { SchedulesService, type ScheduleActor } from './schedules.service';

type Headers = { headers: Record<string, string | string[] | undefined> };

/** Who a REST request is: a token, an acting session, or the person signed in. */
export function scheduleActorOf(user: AuthUser, request: Headers): ScheduleActor {
  const acting = actingSession(request.headers);
  if (acting !== null) {
    let sessionId: string;
    try {
      sessionId = toUuid(acting);
    } catch {
      throw new ForbiddenException('X-Orbit-Session names no session of this account');
    }
    return { kind: 'SESSION', ownerId: user.userId, sessionId };
  }
  if (user.credential?.kind === 'PAT') return { kind: 'PAT', ownerId: user.userId };
  return { kind: 'OWNER', ownerId: user.userId };
}

/** The first turn of a quick-add session: the person's sentence, and what to do with it (§8.1). */
export function scheduleDraftPrompt(text: string): string {
  return [
    'The person typed this on the Scheduled page, to create a scheduled task:',
    '',
    text.trim(),
    '',
    'Turn it into one with mcp__orbit__schedule_create. When you can, do the check once first and pass what you found '
      + 'as the baseline. Ask back only for what only the person can decide, such as how often.',
  ].join('\n');
}

const READ = { workspaceConfinable: false } as const;

/**
 * The page chat's doors are the person's: a session (one acting through `X-Orbit-Session`) reads and changes schedules
 * with its own tools, and neither opens a conversation in the person's name nor reads the person's chat.
 */
async function refusePageChatFromSession(req: Headers, user: AuthUser, pageChats: SchedulePageChats): Promise<void> {
  const acting = actingSession(req.headers);
  if (acting !== null) {
    await pageChats.refuseRunSession(user.userId, acting);
    throw new ForbiddenException({
      code: 'SCHEDULE_CHAT_FROM_SESSION',
      message: "A session manages schedules with the schedule tools; the Scheduled page's chat is the person's door.",
    });
  }
}

@UseGuards(JwtAuthGuard)
@Controller()
export class SchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly runs: ScheduleRunsService,
    private readonly reads: ScheduleReadsService,
    private readonly sessions: SessionsService,
    private readonly changes: ScheduleChangeConversations,
    private readonly pageChats: SchedulePageChats,
  ) {}

  @Get('schedules')
  @PatScope('sessions:read', READ)
  list(@CurrentUser() user: AuthUser, @Query('state') state?: string, @Query('workspaceId', PublicIdPipe) workspaceId?: string) {
    return this.reads.list(user.userId, { state, workspaceId, timeline: true });
  }

  @Get('schedules/drafts')
  @PatScope('sessions:read', READ)
  drafts(@CurrentUser() user: AuthUser) {
    return this.reads.drafts(user.userId);
  }

  /**
   * The quick-add line: opens an ordinary session in the named workspace with the sentence, which then calls
   * `schedule_create`; its card shows as a draft (`GET /api/schedules/drafts`, the card's `askedBySessionId`). The
   * session has no powers a session started any other way lacks, and stays in its workspace's session list.
   */
  @Post('schedules/drafts')
  @PatScope('sessions:write', { workspaceConfinable: { body: { workspaceId: 'workspace' }, requires: ['workspaceId'] } })
  async draft(
    @CurrentUser() user: AuthUser,
    @Body(PublicIdPipe.forFields('workspaceId')) dto: ScheduleDraftDto,
  ) {
    const session = await this.sessions.create(
      user.userId,
      { workspaceId: dto.workspaceId, prompt: scheduleDraftPrompt(dto.text) },
      { credential: user.credential },
    );
    return { sessionId: (session as { id: string }).id, session };
  }

  /**
   * The Scheduled page's chat (docs/scheduled-chat-design.md §4.1, §4.3): the account's open page chat, if any, and the
   * opening Orbit draws from its schedules for a new one. Nothing is written and no engine starts: the chat exists from
   * the person's first words (`POST`). Declared before `schedules/:id`, which would take `chat` for an id.
   * `?timezone=` is the reading device's IANA zone: the next-run line names the schedule's zone when it differs.
   */
  @Get('schedules/chat')
  @PatScope('sessions:read', READ)
  async pageChat(@CurrentUser() user: AuthUser, @Req() req: Headers, @Query('timezone') timezone?: string) {
    await refusePageChatFromSession(req, user, this.pageChats);
    if (timezone !== undefined) {
      try {
        assertTimezone(timezone);
      } catch {
        throw new BadRequestException({
          code: 'SCHEDULE_TIMEZONE_INVALID',
          message: 'timezone is the IANA time zone of the device reading the chat, such as Europe/Berlin, or is left out',
        });
      }
    }
    return this.pageChats.read(user.userId, timezone);
  }

  /**
   * Opens the page chat in the named workspace with the person's first words, or says them in that workspace's open
   * one (`created: false`). It opens a session and changes no schedule: the session changes schedules with its own
   * tools, under their envelope.
   */
  @Post('schedules/chat')
  @PatScope('sessions:write', { workspaceConfinable: { body: { workspaceId: 'workspace' }, requires: ['workspaceId'] } })
  @HttpCode(HttpStatus.OK)
  async openPageChat(
    @CurrentUser() user: AuthUser,
    @Body(PublicIdPipe.forFields('workspaceId')) dto: SchedulePageChatDto,
    @Req() req: Headers,
  ) {
    await refusePageChatFromSession(req, user, this.pageChats);
    return this.pageChats.open(user, dto.workspaceId, dto.text);
  }

  /**
   * Change… (§8.2): the schedule's open change conversation, if any, and the opening Orbit draws for a new one. Nothing
   * is written: the conversation exists from the person's first words (`POST`).
   */
  @Get('schedules/:id/change')
  @PatScope('sessions:read', READ)
  change(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.changes.read(user.userId, id);
  }

  /**
   * Opens the schedule's change conversation with the person's first words. The person's door: a session (one acting
   * through `X-Orbit-Session`) changes a schedule with its own tools, not by opening a conversation in the person's
   * name, so it is refused.
   */
  @Post('schedules/:id/change')
  @PatScope('sessions:write', READ)
  @HttpCode(HttpStatus.OK)
  openChange(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ScheduleChangeDto,
    @Req() req: Headers,
  ) {
    if (actingSession(req.headers) !== null) {
      throw new ForbiddenException({
        code: 'SCHEDULE_CHANGE_FROM_SESSION',
        message: 'A session changes a schedule with schedule_update; Change… is the person\'s door.',
      });
    }
    return this.changes.open(user, id, dto.text);
  }

  @Get('schedules/:id')
  @PatScope('sessions:read', READ)
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.reads.get(user.userId, id);
  }

  @Get('schedules/:id/runs')
  @PatScope('sessions:read', READ)
  listRuns(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    return this.reads.runs(user.userId, id, { limit: limit ? Number(limit) : undefined, before });
  }

  @Post('schedules/:id/pause')
  @PatScope('sessions:write', READ)
  @HttpCode(HttpStatus.OK)
  async pause(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() req: Headers) {
    return this.reads.controlAnswer(user.userId, await this.schedules.pause(scheduleActorOf(user, req), id));
  }

  @Post('schedules/:id/resume')
  @PatScope('sessions:write', READ)
  @HttpCode(HttpStatus.OK)
  async resume(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() req: Headers) {
    return this.reads.controlAnswer(user.userId, await this.schedules.resume(scheduleActorOf(user, req), id));
  }

  /** Rename (§8.4): the title alone; answers as Undo does, with the schedule and the change's record. */
  @Post('schedules/:id/rename')
  @PatScope('sessions:write', READ)
  @HttpCode(HttpStatus.OK)
  async rename(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ScheduleRenameDto,
    @Req() req: Headers,
  ) {
    return this.reads.updateAnswer(user.userId, await this.schedules.rename(scheduleActorOf(user, req), id, dto.title));
  }

  /** Run now: a MANUAL run under the overlap rule; refused when ENDED (§8.4). */
  @Post('schedules/:id/run')
  @PatScope('sessions:write', READ)
  @HttpCode(HttpStatus.OK)
  async runNow(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() req: Headers) {
    return { run: scheduleRunView(await this.runs.runNow(scheduleActorOf(user, req), id)) };
  }

  @Post('schedules/:id/undo')
  @PatScope('sessions:write', READ)
  @HttpCode(HttpStatus.OK)
  async undo(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ScheduleUndoDto,
    @Req() req: Headers,
  ) {
    return this.reads.updateAnswer(user.userId, await this.schedules.undo(scheduleActorOf(user, req), id, dto.revision));
  }

  @Delete('schedules/:id')
  @PatScope('sessions:write', READ)
  async remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() req: Headers) {
    return this.reads.controlAnswer(user.userId, await this.schedules.remove(scheduleActorOf(user, req), id));
  }

  @Post('schedule-runs/:id/stop')
  @PatScope('sessions:write', READ)
  @HttpCode(HttpStatus.OK)
  async stop(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() req: Headers) {
    return { run: scheduleRunView(await this.runs.stopRun(scheduleActorOf(user, req), id)) };
  }

  /** The owner's cards, PENDING by default (`?state=all|ALLOWED|…`, `?kind=CREATE|UPDATE`). */
  @Get('schedule-requests')
  @PatScope('sessions:read', READ)
  requests(@CurrentUser() user: AuthUser, @Query('state') state?: string, @Query('kind') kind?: string) {
    return this.reads.requests(user.userId, { state, kind });
  }

  @Get('schedule-requests/:id')
  @PatScope('sessions:read', READ)
  request(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.reads.request(user.userId, id);
  }

  /** Create on a create card, Allow on an envelope card. The owner's own press: no token, no session. */
  @Post('schedule-requests/:id/allow')
  @PatForbidden('OWNER_INTERACTIVE')
  @HttpCode(HttpStatus.OK)
  allow(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ScheduleDecisionDto,
    @Req() req: Headers,
  ) {
    return this.decide(user, id, 'ALLOW', dto, req);
  }

  /** Not now on a create card, Decline on an envelope card. */
  @Post('schedule-requests/:id/decline')
  @PatForbidden('OWNER_INTERACTIVE')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Req() req: Headers) {
    return this.decide(user, id, 'DECLINE', {}, req);
  }

  @Get('sessions/:id/schedule-cards')
  @PatScope('sessions:read', { workspaceConfinable: { params: { id: 'session' } } })
  sessionCards(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.reads.sessionCards(user.userId, id);
  }

  private async decide(user: AuthUser, id: string, decision: 'ALLOW' | 'DECLINE', dto: ScheduleDecisionDto, req: Headers) {
    const result = await this.schedules.decide(scheduleActorOf(user, req), id, decision, {
      timezone: dto.timezone ?? null,
      dropSuggestedEnd: dto.dropSuggestedEnd === true,
    });
    const answer = await this.reads.decisionAnswer(user.userId, result);
    if (result.outcome === 'STALE') {
      throw new ConflictException({
        code: 'SCHEDULE_REQUEST_STALE',
        reason: result.reason,
        message: (result.reason === 'WORKSPACE_GONE'
          ? 'The workspace this card names is no longer yours, so the card was withdrawn and nothing was applied. '
          : 'The schedule changed after this was asked, so the card was withdrawn and nothing was applied. ')
          + 'Ask again from a session if it is still wanted.',
        ...answer,
      });
    }
    return answer;
  }
}
