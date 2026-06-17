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
import { Prisma, RunStatus } from '@prisma/client';
import {
  AgentExecConfig,
  ClaimedSession,
  ConversationTurnKind,
  DevicePollRequest,
  DevicePollResponse,
  DeviceStartRequest,
  DeviceStartResponse,
  MintedAgent,
  PermissionMode,
  ReclaimResponse,
  ReclaimSession,
  RunEventBatch,
  RunEventType,
  RunInboxResponse,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  SessionCompleteRequest,
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
// Interactive sessions (Route B): per-session input long-poll + at-least-once lease.
const INBOX_LONG_POLL_MS = 25_000;
const INBOX_LEASE_MS = 300_000;
const LIVE: RunStatus[] = [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];

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

    // One Runner for the machine (named by hostname), reused if it already exists,
    // plus one Agent per requested coding-tool named `<name>/<key>`. The token is
    // single-use regardless of how many agents are registered.
    const ownerId = enrollment.ownerId;
    const runnerName = dto.hostname || dto.name;
    const runnerToken = generateToken(32);
    const runnerData = {
      hostname: dto.hostname,
      labels: dto.labels ?? [],
      maxConcurrent: dto.maxConcurrent ?? 16,
      version: dto.version,
      tokenHash: sha256(runnerToken),
      status: 'ONLINE' as const,
      lastHeartbeatAt: new Date(),
    };
    const existing = await this.prisma.runner.findFirst({
      where: { ownerId, name: runnerName },
      orderBy: { enrolledAt: 'desc' },
    });
    const runner = existing
      ? await this.prisma.runner.update({ where: { id: existing.id }, data: runnerData })
      : await this.prisma.runner.create({ data: { ...runnerData, name: runnerName, ownerId } });

    const keys = dto.agents?.length ? dto.agents : ['claude'];
    const minted: MintedAgent[] = [];
    for (const key of keys) {
      const name = `${dto.name}/${key}`;
      const ex = await this.prisma.agent.findFirst({ where: { ownerId, runnerId: runner.id, name } });
      const agent = ex
        ? await this.prisma.agent.update({
            where: { id: ex.id },
            data: { agentKey: key, workDir: dto.workDir ?? ex.workDir, runnerId: runner.id, targetRunnerId: runner.id },
          })
        : await this.prisma.agent.create({
            data: { ownerId, runnerId: runner.id, targetRunnerId: runner.id, name, agentKey: key, workDir: dto.workDir },
          });
      minted.push({ agentKey: key, agentId: agent.id, name: agent.name, workDir: agent.workDir ?? undefined });
    }
    await this.prisma.enrollmentToken.update({
      where: { id: enrollment.id },
      data: { usedAt: new Date() },
    });

    return { runnerId: runner.id, runnerToken, name: runner.name, agents: minted };
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
    // Approved — hand the machine runner credential + its agents to the CLI exactly
    // once, then wipe the secret.
    const agents = (session.mintedAgents as unknown as MintedAgent[] | null) ?? [];
    await this.prisma.deviceEnrollment.update({
      where: { id: session.id },
      data: { runnerToken: null, mintedAgents: Prisma.JsonNull },
    });
    return {
      status: 'approved',
      runnerId: session.runnerId,
      runnerToken: session.runnerToken,
      name: session.hostname || session.name,
      agents,
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
            maxConcurrent: dto.maxConcurrent ?? 16,
            version: dto.version,
            agents: dto.agents ?? [],
            workDir: dto.workDir,
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

  /** `orbit status` — the runner's own record + derived online flag + its agents. */
  @UseGuards(RunnerAuthGuard)
  @Get('me')
  async me(
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
    const agents = await this.prisma.agent.findMany({
      where: { runnerId: runner.id },
      select: { id: true, name: true, agentKey: true, workDir: true },
      orderBy: { name: 'asc' },
    });
    return {
      id: runner.id,
      name: runner.name,
      status: runner.status,
      online: runner.status !== 'OFFLINE' && fresh,
      lastHeartbeatAt: runner.lastHeartbeatAt,
      version: runner.version,
      labels: runner.labels,
      maxConcurrent: runner.maxConcurrent,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        agentKey: a.agentKey ?? undefined,
        workDir: a.workDir ?? undefined,
      })),
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
    let cancelSessionIds: string[] = [];
    try {
      cancelSessionIds = await this.realtime.drainCancellations(runner.id);
    } catch {
      // A transient DB hiccup shouldn't fail the heartbeat; cancels arrive next cycle.
    }
    return { cancelSessionIds };
  }

  // ── Interactive sessions (Route B) ──

  /** Long-poll: returns one claimed session, or null when nothing is available. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/claim')
  claim(@CurrentRunner() runner: { id: string }): Promise<ClaimedSession | null> {
    return this.queue.claimSessionForRunner({ id: runner.id }, LONG_POLL_MS);
  }

  /** A restarted runner re-attaches to its still-live sessions and --resumes them. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/reclaim')
  async reclaim(@CurrentRunner() runner: { id: string }): Promise<ReclaimResponse> {
    const sessions = await this.prisma.session.findMany({
      where: { assignedRunnerId: runner.id, status: { in: LIVE } },
      include: { agent: true },
    });
    const out: ReclaimSession[] = [];
    for (const s of sessions) {
      const sessionUuid = s.claudeSessionId;
      if (!sessionUuid) continue;
      const agg = await this.prisma.runEvent.aggregate({
        where: { sessionId: s.id },
        _max: { seq: true },
      });
      const agent = s.agent;
      // Per-session override wins over the agent, then a server default — so a
      // resumed process keeps the model/permission-mode/tools it was created with.
      const agentCfg: AgentExecConfig = {
        model: s.model ?? agent?.model ?? 'claude-sonnet-4-6',
        appendSystemPrompt: agent?.appendSystemPrompt ?? undefined,
        systemPrompt: agent?.systemPrompt ?? undefined,
        allowedTools: (agent?.allowedTools as string[] | null) ?? [],
        disallowedTools: (agent?.disallowedTools as string[] | null) ?? [],
        permissionMode:
          (s.permissionMode as PermissionMode) ??
          (agent?.permissionMode as PermissionMode) ??
          PermissionMode.DONT_ASK,
        maxTurns: agent?.maxTurns ?? undefined,
        maxBudgetUsd: agent?.maxBudgetUsd ?? undefined,
        mcpConfig: (agent?.mcpConfig as Record<string, unknown> | null) ?? undefined,
      };
      out.push({
        sessionId: s.id,
        title: s.title,
        sessionUuid,
        maxSeq: agg._max.seq ?? 0,
        agent: agentCfg,
        workDir: agent?.workDir ?? undefined,
      });
    }
    return { sessions: out };
  }

  /** Per-session long-poll: the next user turn to feed the live claude process. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/inbox')
  async inbox(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
  ): Promise<RunInboxResponse> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const deadline = Date.now() + INBOX_LONG_POLL_MS;
    for (;;) {
      const turn = await this.dequeueTurn(sessionId);
      if (turn) return turn;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { turnId: '', seq: 0, kind: 'message' };
      await this.realtime.waitForInbox(sessionId, Math.min(remaining, 5000));
    }
  }

  /**
   * Atomically lease the next deliverable turn for a session: interrupt/end before
   * message, and PENDING or an expired IN_FLIGHT lease (at-least-once). Flips the
   * session to RUNNING when a message is delivered so a concurrent send is serialized.
   */
  private async dequeueTurn(sessionId: string): Promise<RunInboxResponse | null> {
    const leaseUntil = new Date(Date.now() + INBOX_LEASE_MS);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; seq: number; kind: string; content: string | null }>
    >`
      UPDATE "conversation_turn"
        SET status = 'IN_FLIGHT', "delivered_at" = now(), "lease_deadline_at" = ${leaseUntil}
      WHERE id = (
        SELECT id FROM "conversation_turn"
        WHERE "session_id" = ${sessionId}
          AND ("status" = 'PENDING' OR ("status" = 'IN_FLIGHT' AND "lease_deadline_at" < now()))
        ORDER BY (CASE WHEN "kind" IN ('interrupt', 'end') THEN 0 ELSE 1 END), "seq" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, seq, kind, content
    `;
    if (rows.length === 0) return null;
    const t = rows[0];
    if (t.kind === 'message') {
      await this.prisma.session.updateMany({
        where: {
          id: sessionId,
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

  /** A single interactive turn finished; park the session awaiting the next input. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/turn-complete')
  async turnComplete(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: TurnCompleteRequest,
  ) {
    await this.assertSessionOwnership(sessionId, runner.id);
    const usage = dto.usage;
    await this.prisma.$transaction(async (tx) => {
      // Idempotent ack: only the first turn-complete for this turn applies.
      const ack = await tx.conversationTurn.updateMany({
        where: { id: dto.turnId, sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      if (ack.count === 0) return;
      // Park + bill ONLY if the session is still live and not being torn down, so a
      // late/retried turn-complete can never resurrect a finalized/cancelled session
      // or double-bill it.
      const parked = await tx.session.updateMany({
        where: { id: sessionId, cancelRequestedAt: null, status: { in: LIVE } },
        data: {
          status: RunStatus.AWAITING_INPUT,
          lastTurnAt: new Date(),
          numTurns: { increment: dto.numTurns ?? 1 },
          costUsd: { increment: dto.costUsd ?? 0 },
          sumInputTokens: { increment: usage?.input_tokens ?? 0 },
          sumOutputTokens: { increment: usage?.output_tokens ?? 0 },
          sumCacheRead: { increment: usage?.cache_read_input_tokens ?? 0 },
          sumCacheWrite: { increment: usage?.cache_creation_input_tokens ?? 0 },
        },
      });
      if (parked.count === 0) return; // session no longer live -> turn acked, no billing
      if (dto.modelUsage) {
        const rows = Object.entries(dto.modelUsage).map(([model, mu]) => ({
          sessionId,
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

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/events')
  @HttpCode(202)
  async events(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() batch: RunEventBatch,
  ) {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    const events = batch?.events ?? [];
    if (events.length === 0) return { ok: true };

    // Persist idempotently — RunEvent has @@unique([sessionId, seq]) + skipDuplicates.
    // text_delta is the streaming-animation increment: broadcast it live (below) but
    // DON'T persist it — the full reply is durably saved as the trailing `assistant`
    // event, so replay/refresh still shows complete text without piling up rows.
    const durable = events.filter((e) => e.type !== RunEventType.TEXT_DELTA);
    if (durable.length > 0) {
      await this.prisma.runEvent.createMany({
        data: durable.map((e) => ({
          sessionId,
          seq: e.seq,
          type: e.type,
          payload: e.payload as Prisma.InputJsonValue,
          createdAt: new Date(e.ts),
        })),
        skipDuplicates: true,
      });
    }

    const toolUses = events.filter((e) => e.type === RunEventType.TOOL_USE);
    if (toolUses.length > 0) {
      await this.prisma.toolCall.createMany({
        data: toolUses.map((e) => ({
          sessionId,
          name: String((e.payload as Record<string, unknown>).name ?? 'unknown'),
          input: ((e.payload as Record<string, unknown>).input ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          startedAt: new Date(e.ts),
        })),
      });
    }

    // Only broadcast to live subscribers while the session is active; once finalized,
    // don't let late/replayed events spam the live stream. They remain in the
    // persisted transcript and appear on replay.
    if (session.status === RunStatus.RUNNING) {
      for (const e of events) this.realtime.publish(sessionId, e);
    }
    return { ok: true };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/complete')
  async complete(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: SessionCompleteRequest,
  ) {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];
    if (!TERMINAL.includes(dto.status as RunStatus)) {
      throw new BadRequestException('completion status must be terminal');
    }
    // If the user requested cancel/end, finalize as CANCELLED regardless of what the
    // runner reports — the graceful-end 'end' turn often wins the race over the
    // heartbeat cancel and would otherwise land the session SUCCEEDED.
    const effectiveStatus: RunStatus = session.cancelRequestedAt
      ? RunStatus.CANCELLED
      : (dto.status as RunStatus);

    // Finalize in ONE transaction. Only a LIVE session is finalized (updateMany
    // count): a duplicate/late completion is a safe no-op. Billing is accrued
    // per-turn by /turn-complete, so /complete doesn't touch the sums.
    const finalized = await this.prisma.$transaction(async (tx) => {
      const res = await tx.session.updateMany({
        where: { id: sessionId, status: { in: LIVE } },
        data: {
          status: effectiveStatus,
          result: dto.result,
          error: dto.error,
          claudeSessionId: dto.claudeSessionId ?? undefined,
          finishedAt: new Date(),
        },
      });
      if (res.count === 0) return false;
      // Drain any queued turns so nothing can be leased after the session ends.
      await tx.conversationTurn.updateMany({
        where: { sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      return true;
    });
    if (!finalized) return { ok: true };

    this.realtime.publish(sessionId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      payload: { status: effectiveStatus, final: true },
    });
    return { ok: true };
  }

  private async assertSessionOwnership(sessionId: string, runnerId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.assignedRunnerId !== runnerId) {
      throw new ForbiddenException('session does not belong to this runner');
    }
    return session;
  }
}
