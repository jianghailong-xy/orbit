import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Prisma, RunStatus, TaskStatus } from '@prisma/client';
import {
  ClaimedJob,
  ConversationTurnKind,
  DevicePollRequest,
  DevicePollResponse,
  DeviceStartRequest,
  DeviceStartResponse,
  ReclaimResponse,
  ReclaimRun,
  RunCompleteRequest,
  RunEventBatch,
  RunEventType,
  RunInboxResponse,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  TurnCompleteRequest,
} from '@orbit/shared';
import { generateToken, generateUserCode, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

const LONG_POLL_MS = 25_000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_INTERVAL_S = 3;
// Three missed 30s heartbeats — must match RunnersService's offline window.
const OFFLINE_AFTER_MS = 90_000;
// Interactive sessions (Route B): per-run input long-poll + at-least-once lease.
const INBOX_LONG_POLL_MS = 25_000;
const INBOX_LEASE_MS = 300_000;

@Controller('runner')
export class RunnerApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  /** `orbit register` — exchange a one-time enrollment token for a runner credential. */
  @Post('register')
  async register(@Body() dto: RunnerRegisterRequest): Promise<RunnerRegisterResponse> {
    if (!dto?.enrollmentToken || !dto?.name) {
      throw new UnauthorizedException('enrollmentToken and name are required');
    }
    const enrollment = await this.prisma.enrollmentToken.findUnique({
      where: { tokenHash: sha256(dto.enrollmentToken) },
    });
    if (!enrollment) throw new UnauthorizedException('invalid enrollment token');
    if (enrollment.usedAt) throw new UnauthorizedException('enrollment token already used');
    if (enrollment.expiresAt && enrollment.expiresAt < new Date()) {
      throw new UnauthorizedException('enrollment token expired');
    }

    const runnerToken = generateToken(32);
    const runner = await this.prisma.runner.create({
      data: {
        name: dto.name,
        hostname: dto.hostname,
        ownerId: enrollment.ownerId,
        labels: dto.labels ?? [],
        maxConcurrent: dto.maxConcurrent ?? 1,
        version: dto.version,
        tokenHash: sha256(runnerToken),
        status: 'ONLINE',
        lastHeartbeatAt: new Date(),
      },
    });
    await this.prisma.enrollmentToken.update({
      where: { id: enrollment.id },
      data: { usedAt: new Date() },
    });

    return { runnerId: runner.id, runnerToken, name: runner.name };
  }

  /** `orbit register` (no token) — open a device-login session for browser approval. */
  @Post('device/start')
  async deviceStart(@Body() dto: DeviceStartRequest): Promise<DeviceStartResponse> {
    if (!dto?.name) throw new BadRequestException('name is required');
    const deviceCode = generateToken(32);
    const userCode = await this.createDeviceSession(dto, deviceCode);
    return {
      deviceCode,
      userCode,
      interval: DEVICE_POLL_INTERVAL_S,
      expiresIn: DEVICE_TTL_MS / 1000,
    };
  }

  /** The CLI polls this until the user approves the session in the browser. */
  @Post('device/poll')
  @HttpCode(200)
  async devicePoll(@Body() dto: DevicePollRequest): Promise<DevicePollResponse> {
    if (!dto?.deviceCode) throw new BadRequestException('deviceCode is required');
    const session = await this.prisma.deviceEnrollment.findUnique({
      where: { deviceCodeHash: sha256(dto.deviceCode) },
    });
    if (!session) throw new NotFoundException('unknown device code');
    if (session.expiresAt < new Date()) return { status: 'expired' };
    if (session.status !== 'APPROVED' || !session.runnerId || !session.runnerToken) {
      return { status: 'pending' };
    }
    // Approved — hand the credential to the CLI exactly once, then wipe it.
    await this.prisma.deviceEnrollment.update({
      where: { id: session.id },
      data: { runnerToken: null },
    });
    return {
      status: 'approved',
      runnerId: session.runnerId,
      runnerToken: session.runnerToken,
      name: session.name,
    };
  }

  /** Insert a device session, regenerating the short code on the rare collision. */
  private async createDeviceSession(
    dto: DeviceStartRequest,
    deviceCode: string,
  ): Promise<string> {
    const expiresAt = new Date(Date.now() + DEVICE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = generateUserCode();
      try {
        await this.prisma.deviceEnrollment.create({
          data: {
            deviceCodeHash: sha256(deviceCode),
            userCode,
            name: dto.name,
            hostname: dto.hostname,
            labels: dto.labels ?? [],
            maxConcurrent: dto.maxConcurrent ?? 1,
            version: dto.version,
            expiresAt,
          },
        });
        return userCode;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new Error('could not allocate a unique user code');
  }

  /** `orbit status` — the runner's own record + derived online flag. */
  @UseGuards(RunnerAuthGuard)
  @Get('me')
  me(
    @CurrentRunner()
    runner: {
      id: string;
      name: string;
      status: string;
      lastHeartbeatAt: Date | null;
      version: string | null;
      labels: string[];
      maxConcurrent: number;
    },
  ) {
    const fresh =
      !!runner.lastHeartbeatAt && Date.now() - runner.lastHeartbeatAt.getTime() < OFFLINE_AFTER_MS;
    return {
      id: runner.id,
      name: runner.name,
      status: runner.status,
      online: runner.status !== 'OFFLINE' && fresh,
      lastHeartbeatAt: runner.lastHeartbeatAt,
      version: runner.version,
      labels: runner.labels,
      maxConcurrent: runner.maxConcurrent,
    };
  }

  /** `orbit unregister` — the runner deletes itself from the control plane. */
  @UseGuards(RunnerAuthGuard)
  @Post('deregister')
  @HttpCode(200)
  async deregister(@CurrentRunner() runner: { id: string }) {
    await this.prisma.runner.delete({ where: { id: runner.id } });
    return { ok: true };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('heartbeat')
  async heartbeat(
    @CurrentRunner() runner: { id: string; version: string | null },
    @Body() dto: RunnerHeartbeatRequest,
  ): Promise<RunnerHeartbeatResponse> {
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        status: dto?.status ?? 'ONLINE',
        version: dto?.version ?? runner.version ?? undefined,
        lastHeartbeatAt: new Date(),
      },
    });
    return { cancelRunIds: this.realtime.drainCancellations(runner.id) };
  }

  /** Long-poll: returns one claimed job, or null when nothing is available. */
  @UseGuards(RunnerAuthGuard)
  @Get('jobs')
  jobs(@CurrentRunner() runner: { id: string; labels: string[] }): Promise<ClaimedJob | null> {
    return this.queue.claimForRunner({ id: runner.id, labels: runner.labels }, LONG_POLL_MS);
  }

  // ── Interactive sessions (Route B) ──

  /** A restarted runner re-attaches to its still-live interactive runs and --resumes them. */
  @UseGuards(RunnerAuthGuard)
  @Get('runs/reclaim')
  async reclaim(@CurrentRunner() runner: { id: string }): Promise<ReclaimResponse> {
    const runs = await this.prisma.taskRun.findMany({
      where: {
        runnerId: runner.id,
        interactive: true,
        status: { in: [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
      },
      select: { id: true, claudeSessionId: true, task: { select: { sessionUuid: true } } },
    });
    const out: ReclaimRun[] = [];
    for (const r of runs) {
      const sessionUuid = r.claudeSessionId ?? r.task?.sessionUuid;
      if (!sessionUuid) continue;
      const agg = await this.prisma.runEvent.aggregate({ where: { runId: r.id }, _max: { seq: true } });
      out.push({ runId: r.id, sessionUuid, maxSeq: agg._max.seq ?? 0 });
    }
    return { runs: out };
  }

  /** Per-run long-poll: the next user turn to feed the live claude process. */
  @UseGuards(RunnerAuthGuard)
  @Get('runs/:id/inbox')
  async inbox(
    @CurrentRunner() runner: { id: string },
    @Param('id') runId: string,
  ): Promise<RunInboxResponse> {
    await this.assertOwnership(runId, runner.id);
    const deadline = Date.now() + INBOX_LONG_POLL_MS;
    for (;;) {
      const turn = await this.dequeueTurn(runId);
      if (turn) return turn;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { turnId: '', seq: 0, kind: 'message' };
      await this.realtime.waitForInbox(runId, Math.min(remaining, 5000));
    }
  }

  /** A single interactive turn finished; park the run awaiting the next input. */
  @UseGuards(RunnerAuthGuard)
  @Post('runs/:id/turn-complete')
  async turnComplete(
    @CurrentRunner() runner: { id: string },
    @Param('id') runId: string,
    @Body() dto: TurnCompleteRequest,
  ) {
    await this.assertOwnership(runId, runner.id);
    const usage = dto.usage;
    await this.prisma.$transaction(async (tx) => {
      // Idempotent ack: only the first turn-complete for this turn applies.
      const ack = await tx.conversationTurn.updateMany({
        where: { id: dto.turnId, runId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      if (ack.count === 0) return;
      // Park + bill ONLY if the run is still live and not being torn down, so a
      // late/retried turn-complete can never resurrect a finalized/cancelled run
      // or double-bill it.
      const parked = await tx.taskRun.updateMany({
        where: {
          id: runId,
          cancelRequestedAt: null,
          status: { in: [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
        },
        data: {
          status: RunStatus.AWAITING_INPUT, // session stays alive for the next turn
          lastTurnAt: new Date(),
          numTurns: { increment: dto.numTurns ?? 1 },
          costUsd: { increment: dto.costUsd ?? 0 },
          sumInputTokens: { increment: usage?.input_tokens ?? 0 },
          sumOutputTokens: { increment: usage?.output_tokens ?? 0 },
          sumCacheRead: { increment: usage?.cache_read_input_tokens ?? 0 },
          sumCacheWrite: { increment: usage?.cache_creation_input_tokens ?? 0 },
        },
      });
      if (parked.count === 0) return; // run no longer live -> turn acked, no billing
      if (dto.modelUsage) {
        const rows = Object.entries(dto.modelUsage).map(([model, mu]) => ({
          runId,
          model,
          inputTokens: mu.inputTokens ?? 0,
          outputTokens: mu.outputTokens ?? 0,
          cacheCreationInputTokens: mu.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: mu.cacheReadInputTokens ?? 0,
          costUsd: mu.costUSD ?? 0,
        }));
        if (rows.length > 0) await tx.llmUsage.createMany({ data: rows });
      }
    });
    return { ok: true };
  }

  /**
   * Atomically lease the next deliverable turn for a run: interrupt/end before
   * message, and PENDING or an expired IN_FLIGHT lease (at-least-once). Flips the
   * run to RUNNING when a message is delivered so a concurrent send is serialized.
   */
  private async dequeueTurn(runId: string): Promise<RunInboxResponse | null> {
    const leaseUntil = new Date(Date.now() + INBOX_LEASE_MS);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; seq: number; kind: string; content: string | null }>
    >`
      UPDATE "ConversationTurn"
        SET status = 'IN_FLIGHT', "deliveredAt" = now(), "leaseDeadlineAt" = ${leaseUntil}
      WHERE id = (
        SELECT id FROM "ConversationTurn"
        WHERE "runId" = ${runId}
          AND ("status" = 'PENDING' OR ("status" = 'IN_FLIGHT' AND "leaseDeadlineAt" < now()))
        ORDER BY (CASE WHEN "kind" IN ('interrupt', 'end') THEN 0 ELSE 1 END), "seq" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, seq, kind, content
    `;
    if (rows.length === 0) return null;
    const t = rows[0];
    if (t.kind === 'message') {
      await this.prisma.taskRun.updateMany({
        where: {
          id: runId,
          status: { in: [RunStatus.AWAITING_INPUT, RunStatus.PENDING, RunStatus.INTERRUPTED] },
        },
        data: { status: RunStatus.RUNNING, lastTurnAt: new Date() },
      });
    } else {
      // Control turns (interrupt/end) are fire-and-forget: ack on delivery so a
      // stale one can never re-fire ahead of real messages every lease window.
      await this.prisma.conversationTurn.updateMany({
        where: { id: t.id, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
    }
    return { turnId: t.id, seq: t.seq, kind: t.kind as ConversationTurnKind, content: t.content ?? undefined };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('runs/:id/events')
  @HttpCode(202)
  async events(
    @CurrentRunner() runner: { id: string },
    @Param('id') runId: string,
    @Body() batch: RunEventBatch,
  ) {
    const run = await this.assertOwnership(runId, runner.id);
    const events = batch?.events ?? [];
    if (events.length === 0) return { ok: true };

    // Persist idempotently — RunEvent has @@unique([runId, seq]) + skipDuplicates,
    // so a run's OWN final batch is never lost even if it races with complete().
    await this.prisma.runEvent.createMany({
      data: events.map((e) => ({
        runId,
        seq: e.seq,
        type: e.type,
        payload: e.payload as Prisma.InputJsonValue,
        createdAt: new Date(e.ts),
      })),
      skipDuplicates: true,
    });

    const toolUses = events.filter((e) => e.type === RunEventType.TOOL_USE);
    if (toolUses.length > 0) {
      await this.prisma.toolCall.createMany({
        data: toolUses.map((e) => ({
          runId,
          name: String((e.payload as Record<string, unknown>).name ?? 'unknown'),
          input: ((e.payload as Record<string, unknown>).input ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          startedAt: new Date(e.ts),
        })),
      });
    }

    // Only broadcast to live subscribers while the run is active; once finalized,
    // don't let late/replayed events spam the live stream. They remain in the
    // persisted transcript and appear on replay.
    if (run.status === RunStatus.RUNNING) {
      for (const e of events) this.realtime.publish(runId, e);
    }
    return { ok: true };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('runs/:id/complete')
  async complete(
    @CurrentRunner() runner: { id: string },
    @Param('id') runId: string,
    @Body() dto: RunCompleteRequest,
  ) {
    const run = await this.assertOwnership(runId, runner.id);
    // /complete only FINALIZES; per-turn parking is via /turn-complete. Reject a
    // non-terminal status so a run can't be "completed" into a live state (these
    // DTOs are plain interfaces, so the global ValidationPipe doesn't guard them).
    const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];
    if (!TERMINAL.includes(dto.status as RunStatus)) {
      throw new BadRequestException('completion status must be terminal');
    }
    const usage = dto.usage;
    // If the user requested cancel/end, finalize as CANCELLED regardless of what
    // the runner reports — the graceful-end 'end' turn often wins the race over the
    // heartbeat cancel and would otherwise land the run SUCCEEDED.
    const effectiveStatus: RunStatus = run.cancelRequestedAt
      ? RunStatus.CANCELLED
      : (dto.status as RunStatus);
    const taskStatus: TaskStatus =
      effectiveStatus === RunStatus.SUCCEEDED
        ? TaskStatus.SUCCEEDED
        : effectiveStatus === RunStatus.CANCELLED
          ? TaskStatus.CANCELLED
          : TaskStatus.FAILED;

    // Finalize the run, record usage, and flip the task in ONE transaction so a
    // crash can't leave a finalized run without its billing rows. Only a LIVE run
    // (RUNNING, or an interactive session parked in AWAITING_INPUT/INTERRUPTED) is
    // finalized (updateMany count): a duplicate/late completion is a safe no-op —
    // no double-billed LlmUsage and no resurrecting an already-terminal run.
    const finalized = await this.prisma.$transaction(async (tx) => {
      const res = await tx.taskRun.updateMany({
        where: {
          id: runId,
          status: { in: [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
        },
        data: {
          status: effectiveStatus,
          result: dto.result,
          subtype: dto.subtype,
          error: dto.error,
          claudeSessionId: dto.claudeSessionId,
          finishedAt: new Date(),
          // Interactive billing is accumulated per-turn by /turn-complete; don't
          // clobber it here. One-shot runs report their totals on /complete.
          ...(run.interactive
            ? {}
            : {
                numTurns: dto.numTurns ?? 0,
                costUsd: dto.costUsd ?? 0,
                sumInputTokens: usage?.input_tokens ?? 0,
                sumOutputTokens: usage?.output_tokens ?? 0,
                sumCacheRead: usage?.cache_read_input_tokens ?? 0,
                sumCacheWrite: usage?.cache_creation_input_tokens ?? 0,
              }),
        },
      });
      if (res.count === 0) return false;

      // Interactive LlmUsage is appended per-turn by /turn-complete; only one-shot
      // runs report it here.
      if (!run.interactive && dto.modelUsage) {
        const rows = Object.entries(dto.modelUsage).map(([model, mu]) => ({
          runId,
          model,
          inputTokens: mu.inputTokens ?? 0,
          outputTokens: mu.outputTokens ?? 0,
          cacheCreationInputTokens: mu.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: mu.cacheReadInputTokens ?? 0,
          costUsd: mu.costUSD ?? 0,
        }));
        if (rows.length > 0) await tx.llmUsage.createMany({ data: rows });
      }

      // Don't resurrect a task the user explicitly cancelled, even if the runner
      // reports success for the in-flight run after the cancel was requested.
      await tx.task.updateMany({
        where: { id: run.taskId, status: { not: TaskStatus.CANCELLED } },
        data: { status: taskStatus },
      });
      // Drain any queued turns so nothing can be leased after the session ends.
      await tx.conversationTurn.updateMany({
        where: { runId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      return true;
    });
    if (!finalized) return { ok: true };

    this.realtime.publish(runId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      payload: { status: dto.status, final: true },
    });
    return { ok: true };
  }

  private async assertOwnership(runId: string, runnerId: string) {
    const run = await this.prisma.taskRun.findUnique({ where: { id: runId } });
    if (!run || run.runnerId !== runnerId) {
      throw new ForbiddenException('run does not belong to this runner');
    }
    return run;
  }
}
