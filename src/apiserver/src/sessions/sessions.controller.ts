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
  UseGuards,
} from '@nestjs/common';
import { concat, concatMap, from, map, Observable, switchMap, throwError } from 'rxjs';
import { ApprovalDecisionRequest } from '@orbit/shared';
import { AllowQueryToken } from '../auth/allow-query-token.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Base62UuidPipe } from '../common/base62-uuid.pipe';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateSessionDto, SessionConfigDto, SessionResumeDto, SessionTurnDto } from './dto';
import { SessionsService } from './sessions.service';

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

  @Post(':id/interrupt')
  interrupt(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.interrupt(user.userId, id);
  }

  @Post(':id/end')
  end(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.end(user.userId, id);
  }

  @Post(':id/archive')
  archive(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.archive(user.userId, id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.restore(user.userId, id);
  }

  // Soft-delete: moves the session to the trash (deletedAt), retaining all data.
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', Base62UuidPipe) id: string) {
    return this.sessions.remove(user.userId, id);
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
    return from(
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
  }
}
