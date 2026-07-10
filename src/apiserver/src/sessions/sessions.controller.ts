import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Sse,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { concat, concatMap, from, interval, map, merge, Observable, switchMap, throwError } from 'rxjs';
import { ApprovalDecisionRequest } from '@orbit/shared';
import { AllowQueryToken } from '../auth/allow-query-token.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Base62UuidPipe } from '../common/base62-uuid.pipe';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CreateSessionDto,
  MergeToMainDto,
  SessionConfigDto,
  SessionRenameDto,
  SessionResumeDto,
  SessionTurnDto,
} from './dto';
import { SessionsService } from './sessions.service';

/** ~20s data-plane keepalive (mirrors EventsController): a `ping` data frame — Nest's @Sse can't
 *  emit raw `:` comments — sent on the per-session transcript stream so an *idle* session (one
 *  sitting AWAITING_INPUT emits no events for minutes) still pushes a byte before an intermediary
 *  (Cloudflare reaps idle proxied streams) severs it. Without it the browser eventually shows
 *  ERR_HTTP2_PROTOCOL_ERROR and reconnect-storms. Clients discard the frame by its `ping` type. */
const KEEPALIVE_MS = 20_000;

@UseGuards(JwtAuthGuard)
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSessionDto) {
    return this.sessions.create(user.userId, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('runnerId') runnerId?: string,
    @Query('view') view?: 'active' | 'archived' | 'deleted' | 'system',
  ) {
    return this.sessions.list(user.userId, { runnerId, view });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.get(user.userId, id);
  }

  @Get(':id/artifacts')
  async artifact(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Query('path') artifactPath?: string,
  ): Promise<StreamableFile> {
    const { data, mimeType, disposition } = await this.sessions.getLegacyArtifactForOwner(user.userId, id, artifactPath);
    return new StreamableFile(data, { type: mimeType, disposition, length: data.length });
  }

  // Per-file unified diffs for this session's worktree changes, fetched on demand when a
  // file's diff is opened (kept off the session payload — see SessionsService.getDiff).
  @Get(':id/diff')
  diff(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.getDiff(user.userId, id);
  }

  // Ask the live runner to recompute the worktree diff now, so an opened file whose stored
  // patch lagged the live worktree (the heartbeat refreshes the file list but not the patch
  // text) gets its diff. No-op for a non-live session — see requestDiffRefresh.
  @Post(':id/diff/refresh')
  refreshDiff(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.requestDiffRefresh(user.userId, id);
  }

  @Post(':id/turns')
  turn(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Body() dto: SessionTurnDto,
  ) {
    return this.sessions.createTurn(user.userId, id, dto);
  }

  // Still-queued (PENDING) user messages, so reopening/deep-linking a running session
  // can restore the visible queue (these aren't in the event stream until delivered).
  @Get(':id/turns')
  queuedTurns(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.listQueuedTurns(user.userId, id);
  }

  // Withdraw a still-queued message (turnId is the raw conversation_turn id returned
  // by POST /turns, not a base62 public id).
  @Delete(':id/turns/:turnId')
  cancelTurn(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Param('turnId') turnId: string,
  ) {
    return this.sessions.cancelQueuedTurn(user.userId, id, turnId);
  }

  @Post(':id/resume')
  resume(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Body() dto: SessionResumeDto,
  ) {
    return this.sessions.resume(user.userId, id, dto);
  }

  @Patch(':id/config')
  updateConfig(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Body() dto: SessionConfigDto,
  ) {
    return this.sessions.updateConfig(user.userId, id, dto);
  }

  /** Rename a session's display title. Works on any session (live or ended) and never
   *  touches the runner — purely a metadata update. */
  @Patch(':id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Body() dto: SessionRenameDto,
  ) {
    return this.sessions.rename(user.userId, id, dto.title);
  }

  @Post(':id/interrupt')
  interrupt(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.interrupt(user.userId, id);
  }

  @Post(':id/end')
  end(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.end(user.userId, id);
  }

  /** Ask the runner that ran this session to merge its worktree branch into a target branch
   *  (body.targetBranch; omitted → the runner auto-detects main, else master). */
  @Post(':id/merge')
  mergeToMain(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Body() dto: MergeToMainDto,
  ) {
    return this.sessions.mergeToMain(user.userId, id, dto?.targetBranch);
  }

  /** Ask the runner to commit this live session's uncommitted worktree changes onto its branch. */
  @Post(':id/commit')
  commitWorktree(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.commitWorktree(user.userId, id);
  }

  /** Enable a public read-only share link for this session (mints/returns its shareToken). */
  @Post(':id/share')
  share(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.enableShare(user.userId, id);
  }

  /** Revoke the public share link (the token stops resolving). */
  @Delete(':id/share')
  unshare(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.disableShare(user.userId, id);
  }

  @Post(':id/archive')
  archive(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.archive(user.userId, id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.restore(user.userId, id);
  }

  /** Pin this session to the top of the list (personal ordering). */
  @Post(':id/pin')
  pin(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.pin(user.userId, id);
  }

  /** Remove this session's pin. */
  @Delete(':id/pin')
  unpin(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.unpin(user.userId, id);
  }

  // Soft-delete: moves the session to the trash (deletedAt), retaining all data.
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.remove(user.userId, id);
  }

  // Hard-delete: permanently remove a trashed session and all its data (irreversible).
  @Delete(':id/purge')
  purge(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.purge(user.userId, id);
  }

  /** Tool-permission approvals for this session (optionally filtered by status). */
  @Get(':id/approvals')
  approvals(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Query('status') status?: string,
  ) {
    return this.sessions.listApprovals(user.userId, id, status);
  }

  /** Allow or deny a pending tool-permission approval. */
  @Post(':id/approvals/:approvalId/decision')
  decideApproval(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Param('approvalId') approvalId: string,
    @Body() dto: ApprovalDecisionRequest,
  ) {
    return this.sessions.decideApproval(user.userId, id, approvalId, dto);
  }

  /**
   * The authoritative, complete list of background shells the session ever launched (every
   * Bash(run_in_background), with output recovered from the agent's Read polls). Derived over ALL
   * persisted events, so the "Background processes" tray shows the same complete list on every
   * client regardless of how much transcript is loaded. Clients merge this with a live-derived
   * overlay for the freshest tail of anything still running.
   */
  @Get(':id/background')
  backgroundShells(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.getBackgroundShells(user.userId, id);
  }

  /**
   * A page of a session's persisted events for tail-first lazy loading. `tail=N` returns the
   * newest N (initial paint, so a long transcript opens straight at the latest message instead
   * of replaying its whole history); `before=<seq>&limit=N` returns the N events just older
   * than a seq (scroll-up). `hasMore` signals older events remain.
   */
  @Get(':id/events/page')
  eventPage(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Query('tail') tail?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const num = (s?: string): number | undefined => {
      const n = Number(s);
      return s !== undefined && s !== '' && Number.isFinite(n) ? n : undefined;
    };
    return this.sessions.getEventPage(user.userId, id, {
      tail: num(tail),
      before: num(before),
      limit: num(limit),
    });
  }

  /** Replays a session's persisted events, then streams live ones over SSE. */
  @AllowQueryToken()
  @Sse(':id/events')
  events(
    @CurrentUser() user: AuthUser,
    @Param('id', Base62UuidPipe) id: string,
    @Query('sinceSeq') sinceSeq?: string,
  ): Observable<MessageEvent> {
    // On reconnect, replay only events after sinceSeq (the client also dedups by
    // seq, but this avoids re-sending a long transcript every time).
    const since = Number(sinceSeq);
    const seqFilter = Number.isFinite(since) && since > 0 ? { gt: since } : undefined;
    // Gate the stream on ownership BEFORE any event is read or the live hub is
    // subscribed, so a non-owner can never see another user's transcript.
    const events$ = from(
      this.prisma.session.findFirst({
        where: { id, ownerId: user.userId },
        select: { id: true },
      }),
    ).pipe(
      switchMap((session) => {
        if (!session) return throwError(() => new ForbiddenException('session not found'));
        const history$ = from(
          this.prisma.runEvent.findMany({
            where: { sessionId: id, ...(seqFilter ? { seq: seqFilter } : {}) },
            orderBy: { seq: 'asc' },
          }),
        ).pipe(concatMap((rows) => from(rows)));
        const live$ = this.realtime.streamForRun(id);
        return concat(history$, live$);
      }),
      map(
        (e: {
          seq: number;
          type: string;
          payload: unknown;
          turnId?: string | null;
          ts?: string;
          createdAt?: Date;
        }) =>
          ({
            data: {
              seq: e.seq,
              type: e.type,
              payload: e.payload,
              turnId: e.turnId ?? null,
              ts: e.ts ?? e.createdAt,
            },
          }) as MessageEvent,
      ),
    );
    // Keep the stream from going byte-idle (see KEEPALIVE_MS): merge a `ping` every ~20s alongside
    // the events. The ownership check above rejects a non-owner within a single DB round-trip —
    // long before the first ping fires — and merge propagates that error, so no ping ever leaks to
    // an unauthorized caller.
    return merge(
      events$,
      interval(KEEPALIVE_MS).pipe(map(() => ({ data: { type: 'ping' } }) as MessageEvent)),
    );
  }
}
