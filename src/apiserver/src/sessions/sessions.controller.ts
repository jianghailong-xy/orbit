import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  MessageEvent,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { concat, concatMap, from, map, Observable, switchMap, throwError } from 'rxjs';
import { AllowQueryToken } from '../auth/allow-query-token.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateSessionDto, SessionTurnDto } from './dto';
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
  list(@CurrentUser() user: AuthUser, @Query('runnerId') runnerId?: string) {
    return this.sessions.list(user.userId, { runnerId });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sessions.get(user.userId, id);
  }

  @Post(':id/turns')
  turn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SessionTurnDto) {
    return this.sessions.createTurn(user.userId, id, dto);
  }

  @Post(':id/interrupt')
  interrupt(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sessions.interrupt(user.userId, id);
  }

  @Post(':id/end')
  end(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sessions.end(user.userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sessions.remove(user.userId, id);
  }

  /** Replays a session's persisted events, then streams live ones over SSE. */
  @AllowQueryToken()
  @Sse(':id/events')
  events(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
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
        (e: { seq: number; type: string; payload: unknown; ts?: string; createdAt?: Date }) =>
          ({
            data: {
              seq: e.seq,
              type: e.type,
              payload: e.payload,
              ts: e.ts ?? e.createdAt,
            },
          }) as MessageEvent,
      ),
    );
  }
}
