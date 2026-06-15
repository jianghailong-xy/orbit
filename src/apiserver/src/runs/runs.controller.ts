import {
  Controller,
  ForbiddenException,
  Get,
  MessageEvent,
  Param,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { concat, concatMap, from, map, Observable, switchMap, throwError } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

@UseGuards(JwtAuthGuard)
@Controller('runs')
export class RunsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const run = await this.prisma.taskRun.findFirst({
      where: { id, task: { ownerId: user.userId } },
      include: {
        toolCalls: { orderBy: { startedAt: 'asc' } },
        llmUsage: true,
        task: { select: { id: true, title: true } },
        runner: { select: { id: true, name: true } },
      },
    });
    if (!run) throw new ForbiddenException('run not found');
    return run;
  }

  /** Replays historical run events, then streams live ones over SSE. */
  @Sse(':id/events')
  events(@CurrentUser() user: AuthUser, @Param('id') id: string): Observable<MessageEvent> {
    // Gate the stream on ownership BEFORE any event is read or the live hub is
    // subscribed, so a non-owner can never see another user's transcript
    // (assistant text, tool inputs, shell output, secrets surfaced by tools).
    return from(
      this.prisma.taskRun.findFirst({
        where: { id, task: { ownerId: user.userId } },
        select: { id: true },
      }),
    ).pipe(
      switchMap((run) => {
        if (!run) return throwError(() => new ForbiddenException('run not found'));
        const history$ = from(
          this.prisma.runEvent.findMany({ where: { runId: id }, orderBy: { seq: 'asc' } }),
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
