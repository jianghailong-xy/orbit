import { Controller, Get, MessageEvent, Param, Sse, UseGuards } from '@nestjs/common';
import { concat, concatMap, from, map, Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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
  get(@Param('id') id: string) {
    return this.prisma.taskRun.findUnique({
      where: { id },
      include: {
        toolCalls: { orderBy: { startedAt: 'asc' } },
        llmUsage: true,
        task: { select: { id: true, title: true } },
        runner: { select: { id: true, name: true } },
      },
    });
  }

  /** Replays historical run events, then streams live ones over SSE. */
  @Sse(':id/events')
  events(@Param('id') id: string): Observable<MessageEvent> {
    const history$ = from(
      this.prisma.runEvent.findMany({ where: { runId: id }, orderBy: { seq: 'asc' } }),
    ).pipe(concatMap((rows) => from(rows)));

    const live$ = this.realtime.streamForRun(id);

    return concat(history$, live$).pipe(
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
