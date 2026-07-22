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
  StreamableFile,
  UploadedFile as UploadedFileParam,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma, RunStatus, TaskStatus } from '@prisma/client';
import {
  AgentProvider,
  AgentExecConfig,
  ArtifactResultRequest,
  ApprovalCreateRequest,
  ApprovalDecisionResponse,
  ApprovalStatus,
  ClaimedSession,
  ConversationTurnKind,
  DevicePollRequest,
  DevicePollResponse,
  DeviceStartRequest,
  DeviceStartResponse,
  isAsyncAgentLaunchAck,
  PermissionMode,
  QuestionAnswers,
  ReclaimResponse,
  ReclaimSession,
  RunEventBatch,
  RunEventType,
  RunInboxResponse,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  SessionCommitResultRequest,
  SessionCompleteRequest,
  SessionDiffResultRequest,
  SessionEndReason,
  SessionMergeResultRequest,
  TurnAttachment,
  TurnCompleteRequest,
} from '@orbit/shared';
import { Base62UuidPipe } from '../common/base62-uuid.pipe';
import { generateToken, generateUserCode, sha256 } from '../common/crypto.util';
import { assertValidUpload, MAX_UPLOAD_BYTES, UploadedFile } from '../attachments/attachments.media';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../push/push.service';
import { normalizeStoredRememberRules } from '../sessions/remember-rules';
import { postRunFailureComment, reclaimStalledTask } from '../tasks/reclaim-stalled-task';
import { CurrentRunner } from './current-runner.decorator';
import { reclaimRuntimeIds } from './reclaim-runtime';
import { isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { runtimeInitSessionId } from './runtime-init';
import { RunnerAuthGuard } from './runner-auth.guard';

const LONG_POLL_MS = 25_000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_INTERVAL_S = 3;
// Three missed 30s heartbeats — must match RunnersService's offline window.
const OFFLINE_AFTER_MS = 90_000;
// Interactive sessions (Route B): per-session input long-poll + at-least-once lease.
const INBOX_LONG_POLL_MS = 25_000;
const INBOX_LEASE_MS = 300_000;
// Tool-permission approvals: the orbit MCP permission tool blocks on this long-poll
// until a human decides. DB-polled (approvals are low-frequency; no NOTIFY needed).
const APPROVAL_LONG_POLL_MS = 25_000;
const APPROVAL_POLL_INTERVAL_MS = 1_500;
const LIVE: RunStatus[] = [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];

function normalizeProvider(value?: string | null): AgentProvider {
  return value === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;
}

function normalizeEffortForProvider(provider: AgentProvider, effort?: string | null): string | undefined {
  if (effort == null) return undefined;
  return provider === AgentProvider.CODEX && effort === 'max' ? 'xhigh' : effort;
}

@Controller('runner')
export class RunnerApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
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

    // One Runner for the machine, reused if it already exists. Agents are
    // registered separately, not here. The token is single-use.
    const ownerId = enrollment.ownerId;
    const runnerName = dto.name;
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
    // Approved — hand the machine runner credential to the CLI exactly once, then
    // wipe the secret.
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
            maxConcurrent: dto.maxConcurrent ?? 16,
            version: dto.version,
            agents: [],
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
      where: { runnerId: runner.id, deletedAt: null },
      select: { id: true, name: true, provider: true, agentKey: true, workDir: true },
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
        provider: a.provider,
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
    const updated = await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        status: dto?.status ?? 'ONLINE',
        version: dto?.version ?? runner.version ?? undefined,
        lastHeartbeatAt: new Date(),
        // Refresh the `/` autocomplete catalog; older runners omit these (leave as-is).
        // Cast: a typed interface[] isn't structurally an InputJsonValue (no index sig).
        availableCommands: (dto?.commands ?? undefined) as Prisma.InputJsonValue | undefined,
        availableSkills: (dto?.skills ?? undefined) as Prisma.InputJsonValue | undefined,
        // Latest provider plan-usage snapshot; older runners omit it (leave as-is).
        planUsage: (dto?.planUsage ?? undefined) as Prisma.InputJsonValue | undefined,
        // Runtime model catalog; older runners omit it (leave as-is).
        modelCatalog: (dto?.modelCatalog ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    // Persist each running session's live worktree diff so the composer's status bar can
    // appear mid-turn, not just at turn-complete. The `status in LIVE` guard stops a
    // straggler heartbeat from overwriting a just-finalized session's committed diff;
    // the try/catch keeps a DB hiccup here from failing the heartbeat (→ reads as offline).
    if (dto?.sessions?.length) {
      try {
        await Promise.all(
          dto.sessions.map(async (s) => {
            await this.prisma.session.updateMany({
              where: { id: s.sessionId, assignedRunnerId: runner.id, status: { in: LIVE } },
              data: {
                isolationStatus: s.isolationStatus,
                changedFiles: (s.changedFiles ?? []) as unknown as Prisma.InputJsonValue,
                // Drives the status bar's Commit-vs-Merge action (older runners omit it →
                // left untouched, so the bar falls back to the session lifecycle).
                ...(s.worktreeDirty !== undefined ? { worktreeDirty: s.worktreeDirty } : {}),
                // Candidate branches for the "Merge to…" dropdown (older runners omit it).
                ...(s.mergeTargets !== undefined ? { mergeTargets: s.mergeTargets } : {}),
                // Whether the branch already landed in main → bar shows "✓ In main", not a
                // redundant Merge button (older runners omit it → left untouched).
                ...(s.branchMerged !== undefined ? { branchMerged: s.branchMerged } : {}),
              },
            });
            // New commits after an earlier merge: retire the stale "✓ Merged" so the bar
            // offers Merge again for the new work.
            await this.clearStaleMergedStatus(s.sessionId, runner.id, s.branchMerged);
          }),
        );
      } catch {
        // Next heartbeat retries; the status bar tolerates a one-cycle lag.
      }
    }
    let cancelSessionIds: string[] = [];
    let mergeRequests: RunnerHeartbeatResponse['mergeRequests'] = [];
    let commitRequests: RunnerHeartbeatResponse['commitRequests'] = [];
    let artifactRequests: RunnerHeartbeatResponse['artifactRequests'] = [];
    try {
      cancelSessionIds = await this.realtime.drainCancellations(runner.id);
      mergeRequests = await this.realtime.drainMergeRequests(runner.id);
      commitRequests = await this.realtime.drainCommitRequests(runner.id);
      artifactRequests = await this.realtime.drainArtifactRequests(runner.id);
    } catch {
      // A transient DB hiccup shouldn't fail the heartbeat; all arrive next cycle.
    }
    // Hand back the authoritative max-concurrent (the editable DB value) so the runner
    // syncs its self-gate to a UI/API change without needing a restart.
    return { cancelSessionIds, maxConcurrent: updated.maxConcurrent, mergeRequests, commitRequests, artifactRequests };
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
      const agent = s.agent;
      const declared = s.provider ?? agent?.provider ?? null;
      // Custom provider borrows a built-in runtime — resolve the runner-facing provider, model,
      // and injected env so a resumed session keeps talking to the configured endpoint. Owner
      // scope mirrors the claim path: a personal provider resolves only for its owner's sessions.
      const customRow = isBuiltinProvider(declared)
        ? null
        : await this.prisma.modelProvider.findFirst({
            where: { slug: declared!, OR: [{ ownerId: null }, { ownerId: s.ownerId }] },
          });
      const exec = resolveProviderExec({
        declaredProvider: declared,
        customRow,
        sessionModel: s.model,
        agentModel: agent?.model,
        agentEnv: agent?.env as Record<string, string> | null,
      });
      const provider = exec.provider;
      const runtime = reclaimRuntimeIds({
        provider,
        sessionId: s.id,
        runtimeSessionId: s.runtimeSessionId,
        claudeSessionId: s.claudeSessionId,
      });
      if (!runtime) continue;
      const agg = await this.prisma.runEvent.aggregate({
        where: { sessionId: s.id },
        _max: { seq: true },
      });
      // Per-session override wins over the agent, then a server default — so a
      // resumed process keeps the model/permission-mode/tools it was created with; a
      // cross-provider model id is coerced so a reclaim never resumes `codex -m claude-*`.
      const agentCfg: AgentExecConfig = {
        provider,
        model: exec.model,
        appendSystemPrompt: agent?.appendSystemPrompt ?? undefined,
        systemPrompt: agent?.systemPrompt ?? undefined,
        allowedTools: (agent?.allowedTools as string[] | null) ?? [],
        disallowedTools: (agent?.disallowedTools as string[] | null) ?? [],
        permissionMode:
          (s.permissionMode as PermissionMode) ??
          (agent?.permissionMode as PermissionMode) ??
          PermissionMode.DONT_ASK,
        // Per-session effort wins; else the agent's default effort (like model/mode above).
        effort: normalizeEffortForProvider(provider, s.effort ?? agent?.effort),
        maxTurns: agent?.maxTurns ?? undefined,
        maxBudgetUsd: agent?.maxBudgetUsd ?? undefined,
        mcpConfig: (agent?.mcpConfig as Record<string, unknown> | null) ?? undefined,
        // Includes a custom provider's injected baseUrl/key (else just the agent's env).
        env: exec.env,
      };
      out.push({
        sessionId: s.id,
        provider,
        runtimeSessionId: runtime.runtimeSessionId,
        title: s.title,
        sessionUuid: runtime.sessionUuid,
        maxSeq: agg._max.seq ?? 0,
        agent: agentCfg,
        workDir: agent?.workDir ?? undefined,
        branch: s.branch ?? undefined,
        autoInitGit: agent?.autoInitGit ?? undefined,
        // cf. the claim path: the branch this session merges into, so a restarted runner
        // still judges "already merged" against it rather than main.
        mergeTarget: s.mergeTarget ?? agent?.defaultMergeTarget ?? undefined,
        agentId: s.agentId ?? undefined,
        taskId: s.taskId ?? undefined,
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
   * Fetch one of a turn's image attachments as raw bytes, for the runner to base64-encode
   * into a claude `image` content block (the ids/mimes arrive on the inbox). Runner-scoped
   * (not the user-JWT /api/attachments/:id): the attachment must belong to a session this
   * runner owns, so a runner can't read another tenant's blobs.
   */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/attachments/:attId')
  async attachment(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Param('attId') attId: string,
  ): Promise<StreamableFile> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const att = await this.prisma.attachment.findFirst({
      where: { id: attId, sessionId },
      select: { data: true, mimeType: true },
    });
    if (!att) throw new NotFoundException('attachment not found');
    const data = Buffer.from(att.data);
    return new StreamableFile(data, { type: att.mimeType, disposition: 'inline', length: data.length });
  }

  /**
   * Persist a runner-produced artifact (currently assistant markdown images) as a normal
   * session attachment. The browser cannot read `/root/...` paths from the runner, so the
   * runner uploads bytes here and rewrites the transcript markdown to `orbit-attachment:<id>`.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async uploadAttachment(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @UploadedFileParam() file: UploadedFile | undefined,
  ): Promise<{ id: string }> {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    assertValidUpload(file);
    const f = file as UploadedFile;
    const row = await this.prisma.attachment.create({
      data: {
        ownerId: session.ownerId,
        sessionId,
        mimeType: f.mimetype,
        sizeBytes: f.size,
        fileName: f.originalname || null,
        data: f.buffer,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/artifacts/result')
  async artifactResult(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: ArtifactResultRequest,
  ): Promise<{ ok: true }> {
    await this.assertSessionOwnership(sessionId, runner.id);
    if (!dto?.requestId) throw new BadRequestException('requestId is required');
    await this.prisma.conversationTurn.updateMany({
      where: { id: dto.requestId, sessionId, kind: 'artifact' },
      data: { status: 'ANSWERED', answeredAt: new Date() },
    });
    return { ok: true };
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
        WHERE "session_id" = ${sessionId}::uuid
          AND (
            -- interrupt/end land immediately, even mid-message (interrupt is the point).
            -- 'diff' (an on-demand live-diff refresh) is read-only and claude-independent, so
            -- it lands immediately too — even mid-turn — and is acked on delivery below.
            ("kind" IN ('interrupt', 'end', 'diff')
              AND ("status" = 'PENDING' OR ("status" = 'IN_FLIGHT' AND "lease_deadline_at" < now())))
            -- A crashed in-flight message: re-deliver the same one (at-least-once lease).
            OR ("kind" IN ('message', 'shell') AND "status" = 'IN_FLIGHT' AND "lease_deadline_at" < now())
            -- reload (a model/mode/effort change) and the next queued message both wait
            -- until no message is in flight, so a config change made mid-turn applies
            -- between turns (re-spawn) instead of aborting the running one. reload is
            -- ordered ahead of queued messages below, so the next turn runs under it.
            OR ("kind" IN ('reload', 'message', 'shell') AND "status" = 'PENDING' AND NOT EXISTS (
              SELECT 1 FROM "conversation_turn" inflight
              WHERE inflight."session_id" = ${sessionId}::uuid
                AND inflight."kind" IN ('message', 'shell')
                AND inflight."status" = 'IN_FLIGHT'
            ))
          )
        ORDER BY (CASE WHEN "kind" IN ('interrupt', 'end', 'diff') THEN 0 WHEN "kind" = 'reload' THEN 1 ELSE 2 END), "seq" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, seq, kind, content
    `;
    if (rows.length === 0) return null;
    const t = rows[0];
    let attachments: TurnAttachment[] | undefined;
    if (t.kind === 'message' || t.kind === 'shell') {
      // A shell turn runs on the runner too, so flip RUNNING the same way — it serializes
      // a concurrent send and keeps the idle reaper off while the command executes.
      await this.prisma.session.updateMany({
        where: {
          id: sessionId,
          status: { in: [RunStatus.AWAITING_INPUT, RunStatus.PENDING, RunStatus.INTERRUPTED] },
        },
        data: { status: RunStatus.RUNNING, lastTurnAt: new Date() },
      });
      // Hand the runner this turn's attachment refs (id + mime + filename); it fetches the
      // bytes via GET /api/attachments/:id and dispatches on the type (image/PDF inlined as
      // content blocks, anything else written to the worktree). Shell turns have none, so
      // the field is omitted.
      if (t.kind === 'message') {
        const atts = await this.prisma.attachment.findMany({
          where: { turnId: t.id },
          select: { id: true, mimeType: true, fileName: true },
          orderBy: { createdAt: 'asc' },
        });
        if (atts.length > 0) {
          attachments = atts.map((a) => ({
            id: a.id,
            mimeType: a.mimeType,
            fileName: a.fileName ?? undefined,
          }));
        }
      }
    } else {
      // Control turns (interrupt/end/reload/diff) are fire-and-forget: ack on delivery so a
      // stale one can never re-fire ahead of real messages every lease window.
      await this.prisma.conversationTurn.updateMany({
        where: { id: t.id, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
    }
    return {
      turnId: t.id,
      seq: t.seq,
      kind: t.kind as ConversationTurnKind,
      content: t.content ?? undefined,
      attachments,
    };
  }

  /**
   * Register a tool-permission request from claude's --permission-prompt-tool (served
   * by the orbit MCP server) and surface it to the UI. Idempotent on toolUseId so a
   * retried call returns the same approval. The MCP tool then polls /approvals/:id.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/approvals')
  async createApproval(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: ApprovalCreateRequest,
  ): Promise<{ id: string; status: ApprovalStatus }> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const existing = dto.toolUseId
      ? await this.prisma.approval.findUnique({
          where: { sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId } },
        })
      : null;
    const approval =
      existing ??
      (await this.prisma.approval.create({
        data: {
          sessionId,
          toolName: dto.toolName,
          input: (dto.input ?? {}) as Prisma.InputJsonValue,
          toolUseId: dto.toolUseId ?? null,
        },
      }));
    if (!existing) {
      this.realtime.publish(sessionId, {
        seq: 0,
        type: RunEventType.APPROVAL_REQUEST,
        payload: {
          id: approval.id,
          toolName: approval.toolName,
          input: approval.input,
          toolUseId: approval.toolUseId ?? undefined,
        },
        ts: new Date().toISOString(),
      });
      // Fire-and-forget: nudge the owner's iOS devices that a reply is needed. Not awaited so a
      // slow APNs round-trip can't delay the runner's approval-create response.
      void this.push.notifyApprovalRequest(sessionId, approval.toolName);
    }
    return { id: approval.id, status: approval.status as ApprovalStatus };
  }

  /** Long-poll one approval until a human decides (window elapsed undecided → PENDING). */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/approvals/:approvalId')
  async pollApproval(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Param('approvalId') approvalId: string,
  ): Promise<ApprovalDecisionResponse> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const deadline = Date.now() + APPROVAL_LONG_POLL_MS;
    for (;;) {
      const a = await this.prisma.approval.findFirst({ where: { id: approvalId, sessionId } });
      if (!a) return { id: approvalId, status: 'DENIED', behavior: 'deny', message: 'approval not found' };
      if (a.status !== 'PENDING') {
        return {
          id: a.id,
          status: a.status as ApprovalStatus,
          behavior: a.status === 'ALLOWED' ? 'allow' : 'deny',
          message: a.message ?? undefined,
          answers: (a.answers as QuestionAnswers | null) ?? undefined,
          ...normalizeStoredRememberRules(a.rememberRule),
        };
      }
      if (Date.now() >= deadline) return { id: a.id, status: 'PENDING' };
      await new Promise((r) => setTimeout(r, APPROVAL_POLL_INTERVAL_MS));
    }
  }

  /** A single interactive turn finished; park the session awaiting the next input. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/turn-complete')
  async turnComplete(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: TurnCompleteRequest,
  ) {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    const usage = dto.usage;
    // A task run that failed mid-turn (e.g. an API/content-filter error the agent
    // couldn't recover from — the runner now reports such turns as FAILED) would
    // otherwise park at AWAITING_INPUT and sit there with the task stuck IN_PROGRESS
    // and nothing watching. For a task-bound session we instead finalize the session
    // FAILED and reclaim the task as FAILED so it surfaces for a human. Chat sessions
    // (no taskId) keep parking so the user can retry in place.
    const failTask = dto.status === RunStatus.FAILED && !!session.taskId;
    const finalized = await this.prisma.$transaction(async (tx) => {
      // Idempotent ack: only the first turn-complete for this turn applies.
      const ack = await tx.conversationTurn.updateMany({
        where: { id: dto.turnId, sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      if (ack.count === 0) return false;
      // A `!`-shell turn runs on the runner, not in claude, so it must NOT advance numTurns:
      // that counter gates --resume on respawn (queue.buildSession). Counting a shell turn
      // would make a shell-first session (claude never received a message) try to --resume a
      // conversation that was never established, failing with "No conversation found".
      const completed = await tx.conversationTurn.findUnique({
        where: { id: dto.turnId },
        select: { kind: true },
      });
      const turnInc = completed?.kind === 'shell' ? 0 : (dto.numTurns ?? 1);
      // Park (or, on a failed task turn, finalize) + bill ONLY if the session is still
      // live and not being torn down, so a late/retried turn-complete can never
      // resurrect a finalized/cancelled session or double-bill it.
      const parked = await tx.session.updateMany({
        where: { id: sessionId, cancelRequestedAt: null, status: { in: LIVE } },
        data: {
          status: failTask ? RunStatus.FAILED : RunStatus.AWAITING_INPUT,
          // On a failed task turn claude is still alive (the turn errored, the process
          // didn't exit), so finalizing FAILED here would leak its runner concurrency
          // slot — the process lingers, holding a slot, until the runner restarts. Set
          // cancelRequestedAt so the next heartbeat's cancel-drain tells the runner to
          // tear that process down and reclaim the slot (mirrors reaper forceFail).
          ...(failTask
            ? { error: dto.result || 'run failed', finishedAt: new Date(), cancelRequestedAt: new Date() }
            : {}),
          // Live worktree state for the composer's status bar, refreshed each turn (the
          // runner reports the worktree's uncommitted diff vs base on every turn-complete).
          isolationStatus: dto.isolationStatus ?? undefined,
          ...(dto.changedFiles !== undefined
            ? { changedFiles: dto.changedFiles as unknown as Prisma.InputJsonValue }
            : {}),
          ...(dto.worktreeDirty !== undefined ? { worktreeDirty: dto.worktreeDirty } : {}),
          // Whether the branch already landed in main — the turn-end snapshot an idle session
          // shows, so the bar offers "✓ In main" not a redundant Merge (older runners omit it).
          ...(dto.branchMerged !== undefined ? { branchMerged: dto.branchMerged } : {}),
          runtimeSessionId: dto.runtimeSessionId ?? undefined,
          lastTurnAt: new Date(),
          numTurns: { increment: turnInc },
          costUsd: { increment: dto.costUsd ?? 0 },
          sumInputTokens: { increment: usage?.input_tokens ?? 0 },
          sumOutputTokens: { increment: usage?.output_tokens ?? 0 },
          sumCacheRead: { increment: usage?.cache_read_input_tokens ?? 0 },
          sumCacheWrite: { increment: usage?.cache_creation_input_tokens ?? 0 },
        },
      });
      if (parked.count === 0) return false; // session no longer live -> turn acked, no billing
      // Per-file unified diffs to the side table (never on the session row, so the detail/
      // list payload stays small) — fetched on demand when the user opens a file's diff.
      if (dto.changedDiff !== undefined) {
        await tx.sessionDiff.upsert({
          where: { sessionId },
          create: { sessionId, patches: dto.changedDiff as unknown as Prisma.InputJsonValue },
          update: { patches: dto.changedDiff as unknown as Prisma.InputJsonValue },
        });
      }
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
      if (failTask) {
        // Drain queued turns so nothing can be leased after the session ends, then
        // surface the abandoned task.
        await tx.conversationTurn.updateMany({
          where: { sessionId, status: { not: 'ANSWERED' } },
          data: { status: 'ANSWERED', answeredAt: new Date() },
        });
        await reclaimStalledTask(tx, session.taskId!, TaskStatus.FAILED);
        await postRunFailureComment(tx, session.taskId!, dto.result || 'run failed');
      }
      return true;
    });
    // Post-turn worktree verdict: new commits after an earlier merge retire the stale
    // "✓ Merged" (see clearStaleMergedStatus). Outside the transaction — independent write,
    // self-guarded, and valid even for a duplicate/late turn-complete.
    await this.clearStaleMergedStatus(sessionId, runner.id, dto.branchMerged);
    if (failTask) {
      // Only announce the terminal status if this call actually finalized the session
      // (a late/duplicate turn-complete for an already-ended session is a no-op).
      if (finalized) {
        this.realtime.publish(sessionId, {
          seq: Number.MAX_SAFE_INTEGER,
          type: RunEventType.STATUS,
          ts: new Date().toISOString(),
          payload: { status: RunStatus.FAILED, final: true },
        });
      }
      return { ok: true };
    }
    // The turn just parked the session at AWAITING_INPUT; wake the inbox poller so any
    // queued follow-up message is leased now instead of after the long-poll window.
    this.realtime.notifyInbox(sessionId);
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
    // text_delta / thinking_delta are streaming-animation increments: broadcast them
    // live (below) but DON'T persist them — the full reply is durably saved as the
    // trailing `assistant` / `thinking` event, so replay/refresh still shows complete
    // text without piling up rows. background_output is the live tail of a background
    // shell's file — same deal (ephemeral animation; the durable record is the agent's
    // own Read snapshots + the background_task completion event).
    const durable = events.filter(
      (e) =>
        e.type !== RunEventType.TEXT_DELTA &&
        e.type !== RunEventType.THINKING_DELTA &&
        e.type !== RunEventType.BACKGROUND_OUTPUT,
    );
    if (durable.length > 0) {
      await this.prisma.runEvent.createMany({
        data: durable.map((e) => ({
          sessionId,
          seq: e.seq,
          type: e.type,
          payload: e.payload as Prisma.InputJsonValue,
          turnId: e.turnId ?? null,
          createdAt: new Date(e.ts),
        })),
        skipDuplicates: true,
      });
    }

    // Codex reports its runtime session id in the app-server `system` init/resumed
    // event; unlike Claude (seeded at session creation) it's otherwise only persisted
    // at /turn-complete. Capture it as soon as it lands so the reaper's codex startup
    // watchdog (reaper.service.ts) can tell a live-but-slow first turn from a runtime
    // that never came up — without this a first turn longer than the startup grace is
    // force-failed as "codex runtime not initialized". Fill only while unset (the id is
    // stable per session), so this is a one-shot, retry-idempotent write.
    if (!session.runtimeSessionId) {
      const runtimeId = runtimeInitSessionId(durable);
      if (runtimeId) {
        await this.prisma.session.updateMany({
          where: { id: sessionId, runtimeSessionId: null },
          data: { runtimeSessionId: runtimeId },
        });
      }
    }

    // Denormalize the latest assistant reply onto the session for the list's preview
    // line. Take the highest-seq assistant event in this batch with non-empty text;
    // seq is monotonic per session, so this only ever advances.
    const lastAssistant = durable
      .filter((e) => e.type === RunEventType.ASSISTANT)
      .reduce<{ seq: number; text: string } | null>((acc, e) => {
        const text = (e.payload as { text?: string } | null)?.text?.trim();
        if (!text) return acc;
        return !acc || e.seq > acc.seq ? { seq: e.seq, text } : acc;
      }, null);
    // Denormalize the "frontier" activity for the sidebar's live status line. The
    // highest-seq durable event is the agent's latest known state: a tool_use means a
    // tool is in flight (its tool_result hasn't landed yet) → surface its name; any
    // other frontier (assistant text, tool_result, turn end) means no tool is running
    // → clear it. Batches arrive in seq order, so the latest batch's frontier is the
    // latest overall. An empty (all-streaming) batch leaves the prior value untouched.
    // The same frontier also carries `userText`: the message text when the latest event is
    // a user turn (a turn just started, no reply yet) → the list shows it while awaiting the
    // reply; any other frontier clears it, flipping the row back to the reply once it lands.
    let frontier: { seq: number; tool: string | null; userText: string | null } | null = null;
    for (const e of durable) {
      // Sub-agent (Task/Agent) events carry the spawning call's parentToolUseId. Skip
      // them: while a sub-agent runs, its own tool_use/tool_result would clobber then
      // clear the parent's frontier, dropping the sidebar out of "Running…" even though
      // the parent's Task call is still in flight. The parent's own tool_use has no
      // parentToolUseId, so it stays the frontier until its tool_result lands.
      if ((e.payload as { parentToolUseId?: string } | null)?.parentToolUseId) continue;
      if (frontier && e.seq <= frontier.seq) continue;
      const tool =
        e.type === RunEventType.TOOL_USE
          ? String((e.payload as { name?: string } | null)?.name ?? '')
              .trim()
              .slice(0, 60) || null
          : null;
      // The pending question, denormalized like the tool above: the user turn's text when it's
      // the frontier. A later frontier (assistant text, a tool, turn end) computes null here,
      // which clears it — so the list swaps the message you just sent back for the reply the
      // moment the agent responds. Stored full; the list query truncates it (left(…, PREVIEW_LEN)).
      const userText =
        e.type === RunEventType.USER
          ? ((e.payload as { text?: string; content?: string } | null)?.text ??
              (e.payload as { content?: string } | null)?.content ??
              '').trim() || null
          : null;
      frontier = { seq: e.seq, tool, userText };
    }
    if (lastAssistant || frontier) {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: {
          ...(lastAssistant ? { lastAssistantText: lastAssistant.text } : {}),
          ...(frontier ? { lastToolUse: frontier.tool, lastUserText: frontier.userText } : {}),
        },
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

    // Maintain the running background-shell set (Session.runningBgShells), which drives the
    // "Background running" status on the list + header. Added on a Bash(run_in_background)
    // launch (keyed by its tool_use id), removed on that task's terminal <task-notification>,
    // and cleared on a (re)spawn (Claude restarted → any prior background children are gone).
    // Atomic array ops stay idempotent under event-batch retries.
    const bgStarted = events
      .filter(
        (e) =>
          e.type === RunEventType.TOOL_USE &&
          (e.payload as { name?: string }).name === 'Bash' &&
          (e.payload as { input?: { run_in_background?: boolean } }).input?.run_in_background ===
            true,
      )
      .map((e) => String((e.payload as { id?: unknown }).id ?? ''))
      .filter(Boolean);
    // Sub-agents (Task/Agent tool) run async: the launch tool_result ("Async agent launched")
    // lands immediately and the parent then streams its own top-scope system progress events,
    // so lastToolUse can't stay 'Agent'. Track in-flight sub-agents the same way as background
    // shells — by their launch tool_use id, cleared by the same terminal background_task
    // (bgEnded) — so the list can show "Running Agent…" the whole time one runs. Only top-level
    // launches count; a sub-agent's own nested tool_use carries parentToolUseId, so skip those.
    const subStarted = events
      .filter(
        (e) =>
          e.type === RunEventType.TOOL_USE &&
          ['Task', 'Agent'].includes(String((e.payload as { name?: string }).name ?? '')) &&
          !(e.payload as { parentToolUseId?: string }).parentToolUseId,
      )
      .map((e) => String((e.payload as { id?: unknown }).id ?? ''))
      .filter(Boolean);
    const bgEnded = events
      .filter(
        (e) =>
          e.type === RunEventType.BACKGROUND_TASK &&
          ['completed', 'failed', 'killed', 'stopped'].includes(
            String((e.payload as { status?: unknown }).status ?? ''),
          ),
      )
      .map((e) => String((e.payload as { toolUseId?: unknown }).toolUseId ?? ''))
      .filter(Boolean);
    // A *synchronous* sub-agent (Task/Agent run inline) reports completion as its own top-level
    // tool_result, never a <task-notification> — so without this it stays in runningSubagents
    // forever and the list is stuck on "Running Agent…". A sub-agent's own nested tool_results
    // carry parentToolUseId (skip those), and an async agent's immediate "Async agent launched"
    // ack is also a top-level tool_result for its id — but that one runs on and is cleared later
    // by its terminal background_task (bgEnded), so exclude it. Any non-sub-agent tool_result id
    // here is harmless: it's simply absent from runningSubagents, so array_remove is a no-op.
    const subEnded = events
      .filter(
        (e) =>
          e.type === RunEventType.TOOL_RESULT &&
          !(e.payload as { parentToolUseId?: string }).parentToolUseId &&
          !isAsyncAgentLaunchAck((e.payload as { content?: unknown }).content),
      )
      .map((e) => String((e.payload as { toolUseId?: unknown }).toolUseId ?? ''))
      .filter(Boolean);
    const bgReset = events.some(
      (e) =>
        e.type === RunEventType.SYSTEM &&
        String((e.payload as { subtype?: unknown }).subtype ?? '') === 'resumed',
    );
    if (bgReset) {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { runningBgShells: [], runningSubagents: [] },
      });
    }
    for (const id of bgStarted) {
      await this.prisma
        .$executeRaw`UPDATE "session" SET "running_bg_shells" = array_append(array_remove("running_bg_shells", ${id}), ${id}) WHERE "id" = ${sessionId}::uuid`;
    }
    for (const id of subStarted) {
      await this.prisma
        .$executeRaw`UPDATE "session" SET "running_subagents" = array_append(array_remove("running_subagents", ${id}), ${id}) WHERE "id" = ${sessionId}::uuid`;
    }
    // A terminal background_task id belongs to either a background shell or a sub-agent;
    // array_remove is a no-op on the set that doesn't hold it, so clear from both.
    for (const id of bgEnded) {
      await this.prisma
        .$executeRaw`UPDATE "session" SET "running_bg_shells" = array_remove("running_bg_shells", ${id}), "running_subagents" = array_remove("running_subagents", ${id}) WHERE "id" = ${sessionId}::uuid`;
    }
    // Clear synchronously-completed sub-agents in one guarded write. The `&&` overlap check means
    // ordinary (non-sub-agent) tool_results — the vast majority — match no rows and never rewrite
    // the hot session row.
    if (subEnded.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE "session"
        SET "running_subagents" = ARRAY(
          SELECT unnest("running_subagents") EXCEPT SELECT unnest(${subEnded}::text[])
        )
        WHERE "id" = ${sessionId}::uuid AND "running_subagents" && ${subEnded}::text[]`;
    }

    // Broadcast to live subscribers while the session is active (any LIVE status);
    // once finalized, don't let late/replayed events spam the live stream — they
    // remain in the persisted transcript and appear on replay. NB: must include
    // AWAITING_INPUT, not just RUNNING — the runner emits a turn's final batch
    // (last text_delta + the authoritative `assistant` + `turn_end`) into its 250ms
    // buffer, then immediately calls /turn-complete, which parks the session at
    // AWAITING_INPUT. So that buffered batch almost always arrives here AFTER the
    // park; gating on RUNNING alone dropped every turn's tail from the live stream
    // (it only reappeared on refresh, via replay).
    if (LIVE.includes(session.status)) {
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
    // If the user requested cancel/end, finalize on the server regardless of what the
    // runner reports — the graceful-end 'end' turn often wins the race over the
    // heartbeat cancel and would otherwise land the session SUCCEEDED. The end reason
    // decides the terminal state: TASK_DONE means the agent finished its task, so settle
    // SUCCEEDED (a completed run must never read as cancelled). IDLE/ENDED (idle-recycle
    // or a user end with work still possible) settle PARKED — terminal but resumable, so
    // the list shows it as dormant rather than cancelled. A hard end
    // (archive=completed / delete=deleted) keeps CANCELLED.
    const PARKED_END: string[] = [SessionEndReason.IDLE, SessionEndReason.ENDED];
    const effectiveStatus: RunStatus = session.cancelRequestedAt
      ? session.endReason === SessionEndReason.TASK_DONE
        ? RunStatus.SUCCEEDED
        : PARKED_END.includes(session.endReason ?? '')
          ? RunStatus.PARKED
          : RunStatus.CANCELLED
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
          runtimeSessionId: dto.runtimeSessionId ?? dto.claudeSessionId ?? undefined,
          finishedAt: new Date(),
          // Worktree isolation outcome reported by the runner: the branch it committed
          // the work to, the base it forked from, what it did (worktree/shared-nogit),
          // and the per-file diff summary. Each left untouched when the runner omits it.
          branch: dto.branch ?? undefined,
          baseSha: dto.baseSha ?? undefined,
          isolationStatus: dto.isolationStatus ?? undefined,
          ...(dto.changedFiles !== undefined
            ? { changedFiles: dto.changedFiles as unknown as Prisma.InputJsonValue }
            : {}),
          // Candidate branches for the ended session's "Merge to…" dropdown (older runners omit it).
          ...(dto.mergeTargets !== undefined ? { mergeTargets: dto.mergeTargets } : {}),
          // finalizeWorktree committed everything onto the branch before /complete, so the
          // checkout is clean — the bar shows Merge (not Commit) for the ended session.
          worktreeDirty: false,
          // The session is ending — Claude (and its background children) are gone, so neither
          // the background-shell set nor any in-flight sub-agent (Task/Agent) can still be live.
          // Clearing runningSubagents here is the teardown backstop for a sub-agent that never got
          // its own terminal signal (e.g. an async agent killed with the session), so the list
          // can't stay stuck on "Running Agent…".
          runningBgShells: [],
          runningSubagents: [],
        },
      });
      if (res.count === 0) return false;
      // Persist the committed branch's per-file diffs to the side table (see turn-complete) —
      // off the session payload, fetched on demand when a file's diff is opened.
      if (dto.changedDiff !== undefined) {
        await tx.sessionDiff.upsert({
          where: { sessionId },
          create: { sessionId, patches: dto.changedDiff as unknown as Prisma.InputJsonValue },
          update: { patches: dto.changedDiff as unknown as Prisma.InputJsonValue },
        });
      }
      // Drain any queued turns so nothing can be leased after the session ends.
      await tx.conversationTurn.updateMany({
        where: { sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      // Abnormal end (FAILED/CANCELLED): if the agent never got to finalize its
      // task, reclaim a now-stalled IN_PROGRESS task so it stops looking like it's
      // still running. A genuine FAILED run lands the task at FAILED (needs a human);
      // a CANCELLED (user end) goes back to OPEN (retryable). SUCCEEDED is left alone —
      // the agent owns DONE.
      if (session.taskId && effectiveStatus !== RunStatus.SUCCEEDED) {
        await reclaimStalledTask(
          tx,
          session.taskId,
          effectiveStatus === RunStatus.FAILED ? TaskStatus.FAILED : TaskStatus.OPEN,
        );
        // Genuine failure (not a user cancel): leave a note on the task explaining it.
        if (effectiveStatus === RunStatus.FAILED) {
          await postRunFailureComment(tx, session.taskId, dto.error || dto.result || 'run failed');
        }
      }
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

  /** Outcome of a heartbeat-delivered MergeCommand — persist it so the worktree status bar
   *  can show merged ✓ / conflict / error. mergedAt + cleared error on success; the message
   *  (git stderr / failed precondition) is kept for conflict/error. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/merge-result')
  async mergeResult(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: SessionMergeResultRequest,
  ) {
    await this.assertSessionOwnership(sessionId, runner.id);
    const merged = dto.status === 'merged';
    // Only accept the outcome while the merge is still pending. The MergeCommand runs async on
    // the runner and is redelivered each heartbeat, so its result can land after a "Resolve in
    // session" resume has already cleared mergeStatus to null — an unconditional write would
    // re-stamp the stale conflict/error and wedge the bar back on "Resolve in session" after
    // the conflict was actually resolved. updateMany no-ops (count 0) when no longer pending.
    await this.prisma.session.updateMany({
      where: { id: sessionId, mergeStatus: 'pending' },
      data: {
        mergeStatus: dto.status,
        mergeError: merged ? null : (dto.message ?? null),
        mergedAt: merged ? new Date() : null,
      },
    });
    return { ok: true };
  }

  /** Outcome of a heartbeat-delivered CommitCommand — persist it so the worktree status bar
   *  can flip from Commit to Merge. On success the worktree is clean (worktreeDirty=false),
   *  so the bar shows Merge without waiting for the next live-diff heartbeat; 'nochange' is
   *  also clean. An error keeps the Commit button (commitError carries git's message). */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/commit-result')
  async commitResult(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: SessionCommitResultRequest,
  ) {
    await this.assertSessionOwnership(sessionId, runner.id);
    const clean = dto.status === 'committed' || dto.status === 'nochange';
    // Same staleness guard as mergeResult: a resume clears commitStatus to null, and an
    // in-flight commit-result landing afterward must not re-stamp it. No-ops when not pending.
    await this.prisma.session.updateMany({
      where: { id: sessionId, commitStatus: 'pending' },
      data: {
        commitStatus: dto.status,
        commitError: dto.status === 'error' ? (dto.message ?? null) : null,
        ...(clean ? { worktreeDirty: false } : {}),
      },
    });
    return { ok: true };
  }

  /** A freshly recomputed live worktree diff, pushed in response to a 'diff' inbox control
   *  turn (the web opened a file whose stored patch lagged). Overwrites the session's
   *  changedFiles and the SessionDiff side-table patches together, so the file list and the
   *  per-file diffs are consistent again. Guarded to LIVE + this runner (mirrors the heartbeat
   *  guard) so a straggler can't clobber a just-finalized session's committed diff. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/diff')
  @HttpCode(202)
  async diffResult(
    @CurrentRunner() runner: { id: string },
    @Param('id') sessionId: string,
    @Body() dto: SessionDiffResultRequest,
  ) {
    await this.assertSessionOwnership(sessionId, runner.id);
    const updated = await this.prisma.session.updateMany({
      where: { id: sessionId, assignedRunnerId: runner.id, status: { in: LIVE } },
      data: {
        ...(dto.changedFiles !== undefined
          ? { changedFiles: dto.changedFiles as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.worktreeDirty !== undefined ? { worktreeDirty: dto.worktreeDirty } : {}),
        // Recomputed with the diff, so opening the drawer refreshes "✓ In main" for an idle
        // session merged out-of-band (older runners omit it → left untouched).
        ...(dto.branchMerged !== undefined ? { branchMerged: dto.branchMerged } : {}),
      },
    });
    // Only persist the patches once we've confirmed the session is still live (count > 0);
    // a no-op update means it finalized, so its committed diff must stay authoritative.
    if (updated.count > 0 && dto.changedDiff !== undefined) {
      await this.prisma.sessionDiff.upsert({
        where: { sessionId },
        create: { sessionId, patches: dto.changedDiff as unknown as Prisma.InputJsonValue },
        update: { patches: dto.changedDiff as unknown as Prisma.InputJsonValue },
      });
    }
    // Opening the diff drawer recomputes branchMerged; new commits after an earlier merge
    // retire the stale "✓ Merged" here too (see clearStaleMergedStatus).
    await this.clearStaleMergedStatus(sessionId, runner.id, dto.branchMerged);
    return { ok: true };
  }

  /** Return the runtime session UUID + workDir so `orbit resume` can reattach locally. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/meta')
  async getSessionMeta(
    @CurrentRunner() runner: { id: string },
    @Param('id', Base62UuidPipe) sessionId: string,
  ): Promise<{
    provider: AgentProvider;
    sessionUuid: string;
    runtimeSessionId?: string;
    workDir: string | null;
    title: string;
  }> {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    const provider = normalizeProvider(session.provider);
    const runtimeSessionId = session.runtimeSessionId ?? session.claudeSessionId ?? undefined;
    if (!runtimeSessionId) {
      throw new NotFoundException('session has no runtime session ID');
    }
    const agent = session.agentId
      ? await this.prisma.agent.findUnique({ where: { id: session.agentId } })
      : null;
    return {
      provider,
      sessionUuid: provider === AgentProvider.CLAUDE ? (session.claudeSessionId ?? runtimeSessionId) : runtimeSessionId,
      runtimeSessionId,
      workDir: agent?.workDir ?? null,
      title: session.title,
    };
  }

  private async assertSessionOwnership(sessionId: string, runnerId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.assignedRunnerId !== runnerId) {
      throw new ForbiddenException('session does not belong to this runner');
    }
    return session;
  }

  /**
   * A worktree report saying the branch is NOT in its merge target (branchMerged === false)
   * means any earlier "✓ Merged" outcome is history — new commits landed on the branch since
   * that merge. Clear the stale terminal 'merged' so the status bar offers Merge again: every
   * client renders the chip from mergeStatus first (web MergeButton returns "✓ Merged" on
   * status === 'merged' before ever looking at the live branchMerged verdict), so without this
   * the bar stays stuck on "✓ Merged" and hides the button for the new work. Guarded on the
   * current value: an in-flight merge ('pending') is never touched, a no-match write is free,
   * and a stale-snapshot report racing a *fresh* merge result at worst blinks the chip for one
   * report cycle (the next report carries branchMerged=true → "✓ In main"). mergedAt is kept —
   * it remains true history of when that earlier merge landed.
   */
  private async clearStaleMergedStatus(
    sessionId: string,
    runnerId: string,
    branchMerged?: boolean,
  ): Promise<void> {
    if (branchMerged !== false) return;
    await this.prisma.session.updateMany({
      where: { id: sessionId, assignedRunnerId: runnerId, mergeStatus: 'merged' },
      data: { mergeStatus: null, mergeError: null },
    });
  }
}
