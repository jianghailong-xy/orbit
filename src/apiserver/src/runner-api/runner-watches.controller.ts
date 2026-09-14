import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerCreateWatchDto, UpdateWatchDto } from '../watches/dto';
import {
  type BareWatchEnd,
  watchEndTurnClientId,
  watchExpiryTurnClientId,
  watchTurnClientId,
} from '../watches/watch-delivery.service';
import { WatchesService } from '../watches/watches.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

/** What a release did, in the words of contracts/watch.contract.json `agentSurface.release`. */
export const WATCH_RELEASE_OUTCOMES = [
  'CANCELLED',
  'WAKE_WITHDRAWN',
  'WAKE_NOT_QUEUED',
  'ALREADY_WOKEN',
  'NOTHING_OWED',
] as const;
export type WatchReleaseOutcome = (typeof WATCH_RELEASE_OUTCOMES)[number];

type WatchView = Awaited<ReturnType<WatchesService['get']>>;

/**
 * The Watch API for agents (docs/watch-contract.md §13), reached by `orbit mcp` and `orbit watch` with the
 * runner credential from inside a session.
 *
 * THE CALLING SESSION IS THE OBSERVER. An agent watches in order to be woken, and the session it can be
 * woken in is the one asking: X-Orbit-Session-Id, a session this runner hosts, observes every watch this
 * door creates, and the body has no field that could name another. Reads and edits are confined to the
 * watches that session observes, so an agent manages its own waits and never the rest of the owner's.
 *
 * WHO MAY WATCH WHAT follows who may read what. Every in-session agent reads the owner's tasks (task_get),
 * so a watch over tasks needs nothing beyond the calling session. Reading another session is session_get's
 * power, so a watch that names a session asks for the orchestration credential session_get asks for.
 * WatchesService still checks every target itself.
 *
 * There is no headless path: outside a session there is nothing to wake.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerWatchesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly watches: WatchesService,
    private readonly sessions: SessionsService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
  ) {}

  @Post('watches')
  async create(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Body() dto: RunnerCreateWatchDto,
  ) {
    const observerSessionId = await this.callingSession(runner, callingSessionId);
    const targets = dto.targets ?? [];
    if (targets.some((target) => target.kind === 'SESSION')) {
      await this.orchestration.assert(runner, observerSessionId, orchestrationToken);
    }
    return this.watches.create(runner.ownerId, {
      predicateVersion: dto.predicateVersion,
      predicate: dto.predicate,
      targets,
      action: dto.action ?? 'RESUME_SESSION',
      observerSessionId,
      ttlSeconds: dto.ttlSeconds,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** The calling session's watches, newest first; `?state=ACTIVE` narrows the list to one state. */
  @Get('watches')
  async list(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Query('state') state: string | undefined,
  ) {
    const observerSessionId = await this.callingSession(runner, callingSessionId);
    return this.watches.list(runner.ownerId, state, { observerSessionId });
  }

  @Get('watches/:id')
  async get(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    const observerSessionId = await this.callingSession(runner, callingSessionId);
    return this.watches.get(runner.ownerId, id, { observerSessionId });
  }

  /** Edit the condition or the deadline of a live watch the calling session observes. */
  @Patch('watches/:id')
  async update(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: UpdateWatchDto,
  ) {
    const observerSessionId = await this.callingSession(runner, callingSessionId);
    await this.watches.get(runner.ownerId, id, { observerSessionId });
    return this.watches.update(runner.ownerId, id, dto);
  }

  @Post('watches/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ) {
    const observerSessionId = await this.callingSession(runner, callingSessionId);
    await this.watches.get(runner.ownerId, id, { observerSessionId });
    return this.watches.cancel(runner.ownerId, id);
  }

  /**
   * Take back what a watch still owes the calling session, because the session got its answer another
   * way: a wait that returned the settled session inline releases the watch that backed it, so the
   * answer arrives once and not a second time as a wake.
   *
   * A watch still waiting is cancelled, and a cancelled watch wakes nobody. A watch that already ended
   * owes a wake turn: once the delivery worker has queued it, and until a runner takes it, it is withdrawn
   * the way an owner withdraws a queued message, which dead-letters the delivery under WAKE_WITHDRAWN
   * (contract §3). A wake not queued yet cannot be withdrawn, so the answer says to ask again.
   */
  @Post('watches/:id/release')
  @HttpCode(HttpStatus.OK)
  async release(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') callingSessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<{ outcome: WatchReleaseOutcome; watch: WatchView }> {
    const observerSessionId = await this.callingSession(runner, callingSessionId);
    const scope = { observerSessionId };
    let watch = await this.watches.get(runner.ownerId, id, scope);
    if (watch.state === 'ACTIVE' || watch.state === 'PAUSED') {
      try {
        return { outcome: 'CANCELLED', watch: await this.watches.cancel(runner.ownerId, id) };
      } catch (error) {
        // The watch ended while the cancel decided, most likely on a Match: what it owes now is its wake.
        if (!(error instanceof ConflictException)) throw error;
        watch = await this.watches.get(runner.ownerId, id, scope);
      }
    }
    const outcome = await this.withdrawWake(runner.ownerId, observerSessionId, watch);
    return { outcome, watch: await this.watches.get(runner.ownerId, id, scope) };
  }

  /** The calling session, when it is one this runner hosts for its owner. */
  private async callingSession(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<string> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException(
        'missing session context: a watch wakes the session that asks for it, so this door needs X-Orbit-Session-Id',
      );
    }
    let id: string;
    try {
      id = toUuid(named);
    } catch {
      throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    }
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId: runner.ownerId, assignedRunnerId: runner.id, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    return session.id;
  }

  private async withdrawWake(ownerId: string, sessionId: string, watch: WatchView): Promise<WatchReleaseOutcome> {
    // Still live after the cancel above lost to a landing that has not committed yet.
    if (watch.state === 'ACTIVE' || watch.state === 'PAUSED') return 'WAKE_NOT_QUEUED';
    const owed = [
      ...watch.matches.flatMap((match) =>
        match.deliveries.map((delivery) => ({ delivery, clientTurnId: watchTurnClientId(watch.id, match.generation) })),
      ),
      ...watch.expiryDeliveries.map((delivery) => ({ delivery, clientTurnId: endTurnClientId(watch.id, delivery.kind) })),
    ].filter(({ delivery }) => delivery.action === 'RESUME_SESSION' && delivery.state !== 'DEAD_LETTER');
    if (owed.length === 0) return 'NOTHING_OWED';
    if (owed.some(({ delivery }) => delivery.state !== 'DELIVERED')) return 'WAKE_NOT_QUEUED';
    let withdrawn = false;
    for (const { clientTurnId } of owed) {
      const turn = await this.prisma.conversationTurn.findUnique({
        where: { sessionId_clientTurnId: { sessionId, clientTurnId } },
        select: { id: true, status: true },
      });
      if (!turn || turn.status !== 'PENDING') continue;
      try {
        await this.sessions.cancelQueuedTurn(ownerId, sessionId, turn.id);
        withdrawn = true;
      } catch (error) {
        // A runner took the turn between the read and the withdrawal.
        if (!(error instanceof ConflictException)) throw error;
      }
    }
    return withdrawn ? 'WAKE_WITHDRAWN' : 'ALREADY_WOKEN';
  }
}

/** The turn key a watch's end was delivered under (contract §3, §5). */
function endTurnClientId(watchId: string, kind: string): string {
  return kind === 'EXPIRY' ? watchExpiryTurnClientId(watchId) : watchEndTurnClientId(watchId, kind as BareWatchEnd);
}
