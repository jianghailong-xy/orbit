import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile as UploadedFileParam,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma, RunStatus, TaskStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  AgentProvider,
  AgentExecConfig,
  ActivateTurnLeasesRequest,
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
  apiErrorRetryAt,
  isAsyncAgentLaunchAck,
  isRetryableApiErrorText,
  isUsageLimitErrorText,
  parseQuotaResetAt,
  planUsageBlockedUntil,
  type PlanUsage,
  PermissionMode,
  QuestionAnswers,
  ReclaimResponse,
  ReclaimSession,
  ReleaseTurnLeasesRequest,
  RunEventBatch,
  RunEventType,
  RunStatus as SharedRunStatus,
  RunInboxResponse,
  RunnerHeartbeatRequest,
  RunnerHeartbeatResponse,
  InstallCommand,
  InstallResult,
  LoginCommand,
  LoginResult,
  OrchestrationCredentialResponse,
  RepoCleanupCommand,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  RunnerRepoCleanupResult,
  SessionCommitResultRequest,
  RunFinalizeRequest,
  RunFinalizeResponse,
  SessionDiffResultRequest,
  SessionEndReason,
  SessionMergeResultRequest,
  TakeoverTurnLeasesRequest,
  TakeoverTurnLeasesResponse,
  TurnAttachment,
  TurnCompleteRequest,
  WorktreesRemovableRequest,
  WorktreesRemovableResponse,
  gracefulEndStatus,
} from '@orbit/shared';
import { lastProviderByAgent, withProviderSeed } from '../agents/agent-provider';
import { generateToken, generateUserCode, sha256 } from '../common/crypto.util';
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForRuntimeModel,
  normalizeRuntimeProvider,
} from '../common/runtime-provider';
import { OPEN_SESSION_STATUSES, statusAfterTurnCompleted } from '../common/session-scheduling';
import { assertValidUpload, MAX_UPLOAD_BYTES, UploadedFile } from '../attachments/attachments.media';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushService } from '../push/push.service';
import { normalizeStoredRememberRules } from '../sessions/remember-rules';
import { postRunFailureComment, reclaimStalledTask } from '../tasks/reclaim-stalled-task';
import { CurrentRunner } from './current-runner.decorator';
import { reclaimRuntimeIds } from './reclaim-runtime';
import {
  RUNTIME_STARTED_EVENT_TYPES,
  RUNTIME_STARTED_SYSTEM_SUBTYPE,
  buildResumeContinuation,
} from './resume-continuation';
import { isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { runtimeInitSessionId } from './runtime-init';
import { engineTurnActiveAfter } from './engine-turn';
import { hasSessionActivity } from './session-activity';
import { stripNul } from './strip-nul';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { isNoiseSystemEvent, notNoiseSql } from '../common/system-noise';
import { isLoginEngine, sanitizeRunnerEngines } from '../common/runner-engines';
import { readRunnerRepoHealth, sanitizeRunnerRepoHealth } from '../common/runner-repo-health';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import {
  isTerminalResumeHandoffOwner,
  pendingWorktreeOperationMayBeExecuting,
  retireSessionInboxGeneration,
} from '../common/session-inbox-fence';
import {
  OPENCODE_RUNNER_UPGRADE_ERROR,
  advertisedRunnerProviders,
  runnerAdvertisesProvider,
} from './runner-provider-support';

// Must stay >= the runner's own loginRelayTimeout (login.go): the runner kills its CLI at that
// point, so anything still marked in-flight past this window has no process behind it.
const LOGIN_RELAY_TIMEOUT_MS = 11 * 60_000;
// Same contract for installs, against the runner's engineInstallTimeout (10 min) plus the
// heartbeat it takes to pick the request up.
const INSTALL_RELAY_TIMEOUT_MS = 12 * 60_000;
// The checkout repair is seconds of local git, so this window only has to cover a runner that
// went away between the click and picking the request up.
const REPO_CLEANUP_TIMEOUT_MS = 3 * 60_000;
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
// Spread over which quota retries are scattered past their reset. See retryPlanFor.
const QUOTA_RETRY_JITTER_MS = 60_000;
const LEASE_GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Session primary keys are UUIDv7, while older rows may still be UUIDv4. Keep
// entity-ID validation separate from the stricter runner-generated lease UUID
// validation above so adding a UUID version cannot take the heartbeat offline.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE: RunStatus[] = [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];
const TERMINAL: RunStatus[] = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];
// PENDING is also open/resumable. In the active-turn model it can briefly coexist with
// a still-warm runtime (a new message arrived after the prior turn released its slot), so
// late event tails and heartbeat snapshots must remain streamable while it waits to claim.
// Keep this distinct from LIVE: /complete must never finalize a freshly queued PENDING turn.
const OPEN = OPEN_SESSION_STATUSES;
// Frontier events that count as the agent *answering* the pending user message, and so clear the
// denormalized `lastUserText` the session list previews. Deliberately narrow: a turn ending, a
// user interrupt, an error or a system/status handshake all end the turn without answering, and
// clearing on those left a session interrupted before its first reply with nothing to preview.
const ANSWERS_USER_TURN: ReadonlySet<RunEventType> = new Set([
  RunEventType.ASSISTANT,
  RunEventType.TOOL_USE,
  RunEventType.TOOL_RESULT,
  RunEventType.RESULT,
]);
const RUNNER_CAPABILITIES_HEADER = 'x-orbit-runner-capabilities';
// Distinct from the named-capability header above: this one advertises which built-in
// runtimes the runner binary can actually drive (runner 0.1.82+).
const RUNNER_PROVIDERS_HEADER = 'x-orbit-supported-providers';
export const SESSION_ORCHESTRATION_CREDENTIAL_V1 = 'session-orchestration-credential-v1';
export const SESSION_TERMINAL_HANDOFF_V1 = 'session-terminal-handoff-v1';
export const SESSION_WORKTREE_OPS_V1 = 'session-worktree-ops-v1';

export function runnerSupportsCapability(
  header: string | string[] | undefined,
  capability: string,
): boolean {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return values.some((value) =>
    value
      .split(',')
      .some((item) => item.trim().toLowerCase() === capability.toLowerCase()),
  );
}

function parseLeaseGeneration(value?: string, field = 'leaseGeneration'): string | null {
  if (value == null || value === '') return null;
  if (!LEASE_GENERATION_RE.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function parseSupervisedSessionId(value: string): string {
  if (!SESSION_ID_RE.test(value)) {
    throw new BadRequestException('supervised session IDs must be UUIDs');
  }
  return value.toLowerCase();
}

@Controller('runner')
export class RunnerApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
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
      ? await this.prisma.runner.update({
          where: { id: existing.id },
          data: runnerData,
        })
      : await this.prisma.runner.create({
          data: { ...runnerData, name: runnerName, ownerId },
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
  private async createDeviceSession(dto: DeviceStartRequest, deviceCode: string): Promise<string> {
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
    const fresh = !!runner.lastHeartbeatAt && Date.now() - runner.lastHeartbeatAt.getTime() < OFFLINE_AFTER_MS;
    const agents = await this.prisma.agent.findMany({
      where: { runnerId: runner.id, deletedAt: null },
      select: {
        id: true,
        name: true,
        agentKey: true,
        workDir: true,
      },
      orderBy: { name: 'asc' },
    });
    // `orbit status` prints a provider per agent, and the column is gone (migration 0088), so
    // derive it the same way every other agent payload does rather than dropping the field —
    // a runner in the field reads it (RunnerAgent.Provider) and would just print nothing.
    const seeded = withProviderSeed(
      agents,
      await lastProviderByAgent(this.prisma, agents.map((a) => a.id)),
    );
    return {
      id: runner.id,
      name: runner.name,
      status: runner.status,
      online: runner.status !== 'OFFLINE' && fresh,
      lastHeartbeatAt: runner.lastHeartbeatAt,
      version: runner.version,
      labels: runner.labels,
      maxConcurrent: runner.maxConcurrent,
      agents: seeded.map((a) => ({
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
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
  ): Promise<RunnerHeartbeatResponse> {
    const heartbeatLeaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    const supportsWorktreeOps = runnerSupportsCapability(capabilities, SESSION_WORKTREE_OPS_V1);
    if ((dto?.supervisedSessionIds?.length ?? 0) > 10_000) {
      throw new BadRequestException('too many supervised session IDs');
    }
    const supervisedSessionIds = heartbeatLeaseOwner
      ? [
          ...new Set(
            (dto?.supervisedSessionIds ?? []).map((id) => parseSupervisedSessionId(id)),
          ),
        ]
      : [];
    const reportedEngines = dto?.engines == null ? null : (sanitizeRunnerEngines(dto.engines) ?? []);
    // Read the engine health this heartbeat is about to overwrite, but only when the incoming
    // report actually claims a signed-out engine — otherwise there is no transition to find and
    // every beat would pay for the lookup.
    const priorEngines = reportedEngines?.some((e) => e.installed && e.auth === 'no')
      ? sanitizeRunnerEngines(
          (
            await this.prisma.runner.findUnique({
              where: { id: runner.id },
              select: { engines: true },
            })
          )?.engines,
        )
      : null;
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
        // Per-engine health for the Providers page. Sanitized on the way in as well as out, so a
        // malformed report can't be stored as a claim about this machine; an older runner omits
        // the field entirely and keeps whatever was last known.
        engines:
          reportedEngines == null
            ? undefined
            : (reportedEngines as unknown as Prisma.InputJsonValue),
        // Runtime-owned default snapshot. Omission means an older runner and preserves the
        // previous value; an explicit {} clears stale values so catalog/static fallback applies.
        runtimeDefaultModels:
          dto?.runtimeDefaultModels == null
            ? undefined
            : (sanitizeRuntimeDefaultModels(dto.runtimeDefaultModels) as Prisma.InputJsonValue),
        // State of the shared checkouts this machine's agents work in, so the UI can warn once
        // that a wedged checkout is blocking every merge here. Omitted by older runners (keep the
        // last snapshot); sanitized in as well as out, since it drives a claim about a machine.
        repoHealth:
          dto?.repos == null
            ? undefined
            : ((sanitizeRunnerRepoHealth(dto.repos) ?? []) as unknown as Prisma.InputJsonValue),
      },
    });
    // An engine that was signed in and now isn't: tell the owner while it is still news, rather
    // than letting them find out from the next session that refuses to start. Only the yes -> no
    // edge counts — 'unknown' means the probe couldn't answer, which is not a claim of a sign-out,
    // and an engine that was already signed out was reported last beat too.
    if (priorEngines) {
      for (const current of reportedEngines ?? []) {
        if (!current.installed || current.auth !== 'no') continue;
        if (!isLoginEngine(current.engine)) continue;
        if (priorEngines.find((was) => was.engine === current.engine)?.auth !== 'yes') continue;
        void this.push.notifyEngineSignedOut(runner.id, current.engine);
      }
    }
    // A finished install stops being news the moment the probe confirms it: clear the slot so the
    // row goes back to speaking from engine health (which then says "signed out", with the sign-in
    // that actually comes next) rather than sitting on a terminal status nobody has to act on.
    //
    // A finished update is the opposite: its summary — what moved, what was skipped and why — is
    // the answer to the button the user pressed, and exists nowhere else. It stays until dismissed.
    if (updated.installStatus === 'done' && updated.installMode !== 'update' && dto?.engines) {
      const reported = sanitizeRunnerEngines(dto.engines) ?? [];
      if (reported.some((e) => e.engine === updated.installEngine && e.installed)) {
        await this.prisma.runner.update({
          where: { id: runner.id },
          data: {
            installStatus: null,
            installEngine: null,
            installCommand: null,
            installMessage: null,
            installAt: null,
            // Retire the whole slot, mode included — the same set cancelInstall clears. A
            // leftover mode is invisible today (installStateOf gates it on the status), which
            // is exactly what would make it outlive the next reader who doesn't.
            installMode: null,
          },
        });
      }
    }
    // A cold supervisor never polls /inbox, so endpoint-level 409 fencing alone
    // cannot tell an overlapping old process to detach it. Echo every locally
    // supervised id and cancel anything that is no longer both open and owned by
    // this exact process. Legacy heartbeats omit leaseOwner and skip this fence.
    let ownershipLostSessionIds: string[] = [];
    if (heartbeatLeaseOwner && supervisedSessionIds.length) {
      try {
        const matching = await this.prisma.session.findMany({
          where: {
            id: { in: supervisedSessionIds },
            assignedRunnerId: runner.id,
            status: { in: OPEN },
            inboxLeaseOwner: heartbeatLeaseOwner,
          },
          select: { id: true },
        });
        const matchingIds = new Set(matching.map((session) => session.id));
        ownershipLostSessionIds = supervisedSessionIds.filter((id) => !matchingIds.has(id));
      } catch {
        // Do not cancel on an indeterminate DB read; the next heartbeat retries.
      }
    }
    // Persist each running session's live worktree diff so the composer's status bar can
    // appear mid-turn, not just at turn-complete. The `status in OPEN` guard stops a
    // straggler heartbeat from overwriting a just-finalized session's committed diff;
    // the try/catch keeps a DB hiccup here from failing the heartbeat (→ reads as offline).
    if (dto?.sessions?.length) {
      try {
        await Promise.all(
          dto.sessions.map(async (s) => {
            const branchMerged = await this.reconcileReportedBranchMerged(
              s.sessionId,
              runner.id,
              s.branchMerged,
              s.branchSha,
              heartbeatLeaseOwner ?? undefined,
            );
            await this.prisma.session.updateMany({
              where: {
                id: s.sessionId,
                assignedRunnerId: runner.id,
                status: { in: OPEN },
                ...(heartbeatLeaseOwner ? { inboxLeaseOwner: heartbeatLeaseOwner } : {}),
              },
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
                ...(branchMerged !== undefined ? { branchMerged } : {}),
                // The worktree's actual HEAD branch → the bar flags divergence from the tracked
                // `branch` and offers Adopt (older runners omit it → left untouched).
                ...(s.worktreeBranch !== undefined ? { worktreeBranch: s.worktreeBranch } : {}),
              },
            });
          }),
        );
      } catch {
        // Next heartbeat retries; the status bar tolerates a one-cycle lag.
      }
    }
    // Record what the runner found at each agent's working directory, so the config form can
    // report a bad path at edit time. Scoped to this runner's own agents: a probe names an
    // agent id, and only the machine that runs it can say anything about its disk.
    if (dto?.agentDirProbes?.length) {
      try {
        await Promise.all(
          dto.agentDirProbes.slice(0, 200).map((p) =>
            this.prisma.agent.updateMany({
              where: { id: p.agentId, runnerId: runner.id, deletedAt: null },
              data: {
                workDirExists: p.exists,
                // Only meaningful when the directory is there; a missing path reports neither.
                workDirIsGit: p.exists ? p.isGitRepo : null,
                workDirProbedAt: new Date(),
              },
            }),
          ),
        );
      } catch {
        // Advisory telemetry — never fail the heartbeat (that would read as offline).
      }
    }
    let cancelSessionIds: string[] = [];
    let mergeRequests: RunnerHeartbeatResponse['mergeRequests'] = [];
    let commitRequests: RunnerHeartbeatResponse['commitRequests'] = [];
    let artifactRequests: RunnerHeartbeatResponse['artifactRequests'] = [];
    let loginRequest: RunnerHeartbeatResponse['loginRequest'];
    let installRequest: RunnerHeartbeatResponse['installRequest'];
    let agentDirs: RunnerHeartbeatResponse['agentDirs'] = [];
    let repoCleanupRequest: RunnerHeartbeatResponse['repoCleanupRequest'];
    try {
      cancelSessionIds = await this.realtime.drainCancellations(runner.id);
      // Manual git mutations are fail-closed during rolling upgrades. A capable
      // runner must advertise its process owner; older binaries leave requests
      // pending until upgraded instead of executing an unfenced operation.
      if (supportsWorktreeOps && heartbeatLeaseOwner) {
        // A claimed request whose owning process died between claim and result would
        // otherwise stay pending forever, fencing takeover/messages/resume for its session.
        await this.realtime.failAbandonedWorktreeOperations(runner.id, heartbeatLeaseOwner);
        // A draining process still heartbeats (so the reaper spares its sessions) but no
        // longer dispatches git work. Claiming for it would pin the session to an epoch
        // that is about to be replaced, which is what the staleness backstop then has to
        // clean up minutes later — the successor process claims these instead.
        if (!dto?.draining) {
          mergeRequests = await this.realtime.drainMergeRequests(runner.id, heartbeatLeaseOwner);
          commitRequests = await this.realtime.drainCommitRequests(runner.id, heartbeatLeaseOwner);
        }
      }
      artifactRequests = await this.realtime.drainArtifactRequests(runner.id);
      loginRequest = await this.drainLoginRequest(runner.id);
      installRequest = await this.drainInstallRequest(runner.id);
      repoCleanupRequest = await this.drainRepoCleanupRequest(runner.id);
      // The directories to stat before the next heartbeat. Sent every cycle rather than on
      // change, so an edited path is picked up without any invalidation to get wrong, and the
      // runner never has to hold an agent list of its own. Last of the block on purpose: it is
      // the only entry here that is a plain listing rather than a one-slot relay, and everything
      // after a throw in this try is skipped until the next heartbeat.
      agentDirs = (
        await this.prisma.agent.findMany({
          where: { runnerId: runner.id, deletedAt: null, workDir: { not: null } },
          select: { id: true, workDir: true },
          take: 200,
        })
      ).map((a) => ({ agentId: a.id, workDir: a.workDir as string }));
    } catch {
      // A transient DB hiccup shouldn't fail the heartbeat; all arrive next cycle.
    }
    // Hand back the authoritative max-concurrent (the editable DB value) so the runner
    // syncs its self-gate to a UI/API change without needing a restart.
    return {
      cancelSessionIds,
      leaseLostSessionIds: ownershipLostSessionIds,
      maxConcurrent: updated.maxConcurrent,
      mergeRequests,
      commitRequests,
      artifactRequests,
      loginRequest,
      installRequest,
      agentDirs,
      repoCleanupRequest,
    };
  }

  /**
   * The checkout repair this runner should run, if one is in flight.
   *
   * `pending` is re-delivered every heartbeat until the runner reports an outcome — the repair is
   * idempotent (a clean checkout is a no-op) and short, so redelivery is cheaper than a claim
   * protocol. An abandoned request is swept on the same principle as the sign-in/install relays:
   * past the window nothing is running it, and leaving it pending would block the next attempt.
   */
  private async drainRepoCleanupRequest(runnerId: string): Promise<RepoCleanupCommand | undefined> {
    const r = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { repoCleanupStatus: true, repoCleanupRoot: true, repoCleanupAt: true },
    });
    if (r?.repoCleanupStatus !== 'pending' || !r.repoCleanupRoot) return undefined;
    const started = r.repoCleanupAt?.getTime() ?? 0;
    if (started && Date.now() - started > REPO_CLEANUP_TIMEOUT_MS) {
      await this.prisma.runner.update({
        where: { id: runnerId },
        data: {
          repoCleanupStatus: 'failed',
          repoCleanupMessage: 'Clean-up timed out — the runner never picked it up. Try again.',
        },
      });
      return undefined;
    }
    return { root: r.repoCleanupRoot, requestedAt: r.repoCleanupAt?.toISOString() ?? '' };
  }

  /**
   * Runner → control plane: how the checkout repair went.
   *
   * The reported state also corrects the stored health snapshot for that root, so the warning
   * clears the moment the repair lands instead of lingering until the runner's next scan (a minute
   * of a banner insisting merges are blocked when they aren't).
   */
  @UseGuards(RunnerAuthGuard)
  @Post('repo-cleanup-result')
  @HttpCode(200)
  async repoCleanupResult(
    @CurrentRunner() runner: { id: string },
    @Body() body: RunnerRepoCleanupResult,
  ) {
    const status = body?.status;
    if (status !== 'done' && status !== 'failed') {
      throw new BadRequestException('Unknown repo cleanup status');
    }
    const current = await this.prisma.runner.findUnique({
      where: { id: runner.id },
      select: { repoHealth: true },
    });
    const reports = readRunnerRepoHealth(current?.repoHealth);
    const repaired =
      body.root && body.state
        ? reports.map((r) => (r.root === body.root ? { ...r, state: body.state!, paths: [] } : r))
        : reports;
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        repoCleanupStatus: status,
        repoCleanupBranch: body.rescueBranch ?? null,
        repoCleanupMessage: body.message ?? null,
        repoHealth: repaired as unknown as Prisma.InputJsonValue,
      },
    });
    return { ok: true };
  }

  /**
   * The engine install this runner should be running, if one is in flight.
   *
   * `pending` re-delivers every heartbeat until the runner's first report moves the row to
   * `installing` — the runner's own guard makes the repeat a no-op. An abandoned install is swept
   * here for the same reason sign-ins are: the runner's installer times out on its own, so a row
   * still in flight past that window has no process behind it and would block the next attempt.
   */
  private async drainInstallRequest(runnerId: string): Promise<InstallCommand | undefined> {
    const r = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { installStatus: true, installEngine: true, installAt: true, installMode: true },
    });
    if (!r?.installStatus) return undefined;
    const update = r.installMode === 'update';
    const started = r.installAt?.getTime() ?? 0;
    if (started && Date.now() - started > INSTALL_RELAY_TIMEOUT_MS) {
      if (r.installStatus === 'pending' || r.installStatus === 'installing') {
        await this.prisma.runner.update({
          where: { id: runnerId },
          data: {
            installStatus: 'failed',
            installMessage: update
              ? 'Update timed out — start it again, or run `orbit engine-update` on that machine.'
              : 'Install timed out — start it again, or run the command by hand.',
          },
        });
      }
      return undefined;
    }
    if (r.installStatus !== 'pending') return undefined;
    // An update names no engine — it does every CLI already on the machine, like the daily loop.
    if (update) return { attempt: r.installAt?.toISOString() ?? '', mode: 'update' };
    if (!isLoginEngine(r.installEngine)) return undefined;
    return { engine: r.installEngine, attempt: r.installAt?.toISOString() ?? '', mode: 'install' };
  }

  /** Runner → control plane: one step of the engine-install relay, scoped to the runner itself. */
  @UseGuards(RunnerAuthGuard)
  @Post('install-result')
  @HttpCode(200)
  async installResult(@CurrentRunner() runner: { id: string }, @Body() body: InstallResult) {
    const status = body?.status;
    if (status !== 'installing' && status !== 'done' && status !== 'failed') {
      throw new BadRequestException('Unknown install status');
    }
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        installStatus: status,
        // The command survives the outcome: on failure it is what the user runs by hand.
        installCommand: body.command ?? undefined,
        installMessage: body.message ?? null,
      },
    });
    return { ok: true };
  }

  /**
   * The next step of this runner's sign-in relay, if one is in flight.
   *
   * `pending` re-delivers `start` every heartbeat until the runner's first status report moves
   * the row to `awaiting_code` — the runner's own guard makes the repeat a no-op. A pasted code
   * is delivered exactly once and cleared immediately: it is single-use, so re-sending it after
   * the CLI consumed it would only ever fail, and holding it longer keeps a credential at rest
   * for no reason.
   *
   * An abandoned relay is swept here rather than by a timer: the runner kills its own CLI after
   * loginRelayTimeout, so a row still `pending`/`awaiting_code` past that window has no process
   * behind it and would otherwise block sign-in forever.
   */
  private async drainLoginRequest(runnerId: string): Promise<LoginCommand | undefined> {
    const r = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: {
        loginStatus: true,
        loginEngine: true,
        loginCode: true,
        loginAt: true,
      },
    });
    if (!r?.loginStatus) return undefined;
    const started = r.loginAt?.getTime() ?? 0;
    if (started && Date.now() - started > LOGIN_RELAY_TIMEOUT_MS) {
      if (r.loginStatus === 'pending' || r.loginStatus === 'awaiting_code' || r.loginStatus === 'awaiting_approval') {
        await this.prisma.runner.update({
          where: { id: runnerId },
          data: {
            loginStatus: 'failed',
            loginCode: null,
            loginUserCode: null,
            loginMessage: 'Sign-in timed out — start it again.',
          },
        });
      }
      return undefined;
    }
    if (r.loginStatus === 'pending')
      return {
        action: 'start',
        // NULL predates the relay driving anything but claude.
        engine: (r.loginEngine as LoginCommand['engine']) ?? 'claude',
        attempt: r.loginAt?.toISOString() ?? '',
      };
    if (r.loginStatus === 'awaiting_code' && r.loginCode) {
      await this.prisma.runner.update({
        where: { id: runnerId },
        data: { loginCode: null },
      });
      return { action: 'code', code: r.loginCode };
    }
    return undefined;
  }

  /**
   * Runner → control plane: one step of the sign-in relay. Authenticated as the runner, and
   * scoped to it, so a runner can only ever move its own row.
   */
  @UseGuards(RunnerAuthGuard)
  @Post('login-result')
  @HttpCode(200)
  async loginResult(@CurrentRunner() runner: { id: string }, @Body() body: LoginResult) {
    const status = body?.status;
    if (status !== 'awaiting_code' && status !== 'awaiting_approval' && status !== 'done' && status !== 'failed') {
      throw new BadRequestException('Unknown login status');
    }
    const waiting = status === 'awaiting_code' || status === 'awaiting_approval';
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: {
        loginStatus: status,
        // A retry after a rejected code republishes the same still-valid URL, so just take
        // whatever the runner reported; clear any code still queued behind it either way.
        loginUrl: waiting ? (body.url ?? null) : null,
        // Only the device flow carries one, and it dies with the attempt it belongs to.
        loginUserCode: status === 'awaiting_approval' ? (body.userCode ?? null) : null,
        loginCode: null,
        loginMessage: body.message ?? null,
      },
    });
    return { ok: true };
  }

  /**
   * Mark pending OpenCode work visibly before refusing a legacy runner. The conditional update
   * repeats the scheduling predicates, so a capable claim/cancel racing this check can never have
   * its now-live/ended row stamped with a stale upgrade error.
   */
  private async markOpenCodeUpgradeRequired(
    runnerId: string,
    candidates?: Array<{ id: string; error: string | null }>,
  ): Promise<boolean> {
    const pending =
      candidates ??
      (await this.prisma.session.findMany({
        where: {
          assignedRunnerId: runnerId,
          status: RunStatus.PENDING,
          provider: AgentProvider.OPENCODE,
          cancelRequestedAt: null,
        },
        select: { id: true, error: true },
      }));
    if (pending.length === 0) return false;
    const unmarked = pending
      .filter((session) => session.error !== OPENCODE_RUNNER_UPGRADE_ERROR)
      .map((session) => session.id);
    if (unmarked.length > 0) {
      const marked = await this.prisma.session.updateMany({
        where: {
          id: { in: unmarked },
          assignedRunnerId: runnerId,
          status: RunStatus.PENDING,
          provider: AgentProvider.OPENCODE,
          cancelRequestedAt: null,
        },
        data: { error: OPENCODE_RUNNER_UPGRADE_ERROR },
      });
      if (marked.count > 0) {
        for (const id of unmarked) this.realtime.publishSessionCreated(id);
      }
    }
    return true;
  }

  // ── Interactive sessions (Route B) ──

  /** Long-poll: returns one claimed session, or null when nothing is available. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/claim')
  async claim(
    @CurrentRunner() runner: { id: string },
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
    @Headers(RUNNER_PROVIDERS_HEADER) providerHeader?: string,
  ): Promise<ClaimedSession | null> {
    const supportsTerminalHandoff = runnerSupportsCapability(capabilities, SESSION_TERMINAL_HANDOFF_V1);
    const supportedProviders = advertisedRunnerProviders(providerHeader);
    if (!supportedProviders.includes(AgentProvider.OPENCODE)) {
      // Explain the stall on the OpenCode rows themselves and then carry on: the claim SQL
      // (plus migration 0080's trigger) already keeps them away from a legacy runner, so
      // failing the request would only strand this runner's Claude/Codex work as well.
      await this.markOpenCodeUpgradeRequired(runner.id);
    }
    const job = await this.queue.claimSessionForRunner(
      { id: runner.id, supportedProviders },
      LONG_POLL_MS,
      supportsTerminalHandoff,
    );
    if (job?.allowOrchestration) {
      if (runnerSupportsCapability(capabilities, SESSION_ORCHESTRATION_CREDENTIAL_V1)) {
        job.orchestrationToken = await this.orchestration.issue(runner.id, job.sessionId);
      } else {
        // Older runners only understand the boolean and would expose orchestration tools
        // without being able to authenticate them. Negotiate the whole feature off.
        job.allowOrchestration = false;
        job.orchestrationToken = undefined;
      }
    }
    // A claimed session may already have a warm process whose inbox long-poll is asleep.
    // Wake it only after the authoritative PENDING->RUNNING transition acquired a slot.
    if (job) this.realtime.notifyInbox(job.sessionId);
    return job;
  }

  /** Retain every open checkout on restart; the payload status tells the runner which is active. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/reclaim')
  async reclaim(
    @CurrentRunner() runner: { id: string; ownerId: string },
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
    @Headers(RUNNER_PROVIDERS_HEADER) providerHeader?: string,
  ): Promise<ReclaimResponse> {
    const supportsOrchestrationCredential = runnerSupportsCapability(
      capabilities,
      SESSION_ORCHESTRATION_CREDENTIAL_V1,
    );
    const supportsTerminalHandoff = runnerSupportsCapability(
      capabilities,
      SESSION_TERMINAL_HANDOFF_V1,
    );
    const sessions = await this.prisma.session.findMany({
      where: { assignedRunnerId: runner.id, ownerId: runner.ownerId, status: { in: OPEN } },
      include: {
        agent: true,
        assignedRunner: { select: { runtimeDefaultModels: true, modelCatalog: true } },
      },
    });
    const openCodeSessions = sessions.filter(
      (session) =>
        (session.provider ?? AgentProvider.CLAUDE) === AgentProvider.OPENCODE,
    );
    const legacyOpenCode =
      openCodeSessions.length > 0 &&
      !runnerAdvertisesProvider(providerHeader, AgentProvider.OPENCODE);
    if (legacyOpenCode) {
      await this.markOpenCodeUpgradeRequired(
        runner.id,
        openCodeSessions
          .filter(
            (session) =>
              session.status === RunStatus.PENDING && session.cancelRequestedAt == null,
          )
          .map((session) => ({ id: session.id, error: session.error })),
      );
      // Omit the rows rather than failing the request. A 426 is not retryable on the runner, so
      // refusing here shuts the whole process down over one session it merely cannot drive. The
      // checkouts stay safe: worktree GC asks `sessions/worktrees-removable`, which keeps every
      // non-terminal session, and the claim SQL never hands an OpenCode row to a legacy runner.
    }
    const reclaimable = legacyOpenCode
      ? sessions.filter((session) => !openCodeSessions.includes(session))
      : sessions;
    // Reclaim never mutates lifecycle/lease ownership. The runner takes each row over with an
    // expected-owner CAS after receiving the snapshot; therefore a timed-out, delayed request
    // cannot retire a generation activated from a newer response. The only write below is an
    // unset-only model snapshot, which prevents a rolling-upgrade session from drifting again.
    const out: ReclaimSession[] = [];
    for (const s of reclaimable) {
      if (!supportsTerminalHandoff && isTerminalResumeHandoffOwner(s.inboxLeaseOwner)) {
        continue;
      }
      const agent = s.agent;
      const declared = s.provider ?? null;
      // Custom provider borrows a built-in runtime — resolve the runner-facing provider, model,
      // and injected env so a resumed session keeps talking to the configured endpoint. Owner
      // scope mirrors the claim path: a personal provider resolves only for its owner's sessions.
      const declaredIsBuiltin = isBuiltinProvider(declared, s.providerBuiltin);
      const customRow = declaredIsBuiltin
        ? null
        : await this.prisma.modelProvider.findFirst({
            where: {
              slug: declared!,
              OR: [{ ownerId: null }, { ownerId: s.ownerId }],
            },
          });
      const resolveExec = (sessionModel: string | null) =>
        resolveProviderExec({
          declaredProvider: declared,
          declaredProviderBuiltin: s.providerBuiltin,
          customRow,
          sessionModel,
          usesRuntimeDefaultModel: s.usesRuntimeDefaultModel,
          runtimeDefaultModels: s.assignedRunner?.runtimeDefaultModels,
          agentModel: agent?.model,
          modelCatalog: s.assignedRunner?.modelCatalog,
          agentEnv: agent?.env as Record<string, string> | null,
        });
      let exec = resolveExec(s.model);
      if (s.model === null || s.model.trim() === '') {
        const materialized = await this.prisma.$executeRaw`
          UPDATE "session"
          SET "model" = ${exec.model}
          WHERE "id" = ${s.id}::uuid
            AND ("model" IS NULL OR btrim("model") = '')
        `;
        if (materialized === 0) {
          // A simultaneous Session config edit owns the value. Return that winner to the runner
          // rather than the stale inherited default from the reclaim snapshot.
          const winner = await this.prisma.session.findUniqueOrThrow({
            where: { id: s.id },
            select: { model: true },
          });
          exec = resolveExec(winner.model);
        }
      }
      const provider = exec.provider;
      const permissionMode =
        (s.permissionMode as PermissionMode) ?? (agent?.permissionMode as PermissionMode) ?? PermissionMode.DONT_ASK;
      const runtime = reclaimRuntimeIds({
        provider,
        sessionId: s.id,
        runtimeSessionId: s.runtimeSessionId,
      });
      if (!runtime) continue;
      const agg = await this.prisma.runEvent.aggregate({
        where: { sessionId: s.id },
        _max: { seq: true },
      });
      // The stored session model wins over Runtime/ModelProvider defaults, so a resumed process
      // keeps the model it was created with; cross-provider ids are still coerced safely.
      const agentCfg: AgentExecConfig = {
        provider,
        model: exec.model,
        appendSystemPrompt: agent?.appendSystemPrompt ?? undefined,
        systemPrompt: agent?.systemPrompt ?? undefined,
        allowedTools: (agent?.allowedTools as string[] | null) ?? [],
        disallowedTools: (agent?.disallowedTools as string[] | null) ?? [],
        permissionMode: normalizeBuiltinPermissionMode(
          provider,
          exec.model,
          permissionMode,
          customRow?.enabled === true,
        ),
        // Per-session effort wins; otherwise use the agent's effort setting.
        // Same dispatch-time variant check as the queue claim: an OpenCode variant is only
        // valid against the assigned runner's reported catalog for this model.
        effort: normalizeEffortForRuntimeModel(
          provider,
          s.effort ?? agent?.effort,
          exec.model,
          s.assignedRunner?.modelCatalog,
        ),
        maxTurns: agent?.maxTurns ?? undefined,
        maxBudgetUsd: agent?.maxBudgetUsd ?? undefined,
        mcpConfig: (agent?.mcpConfig as Record<string, unknown> | null) ?? undefined,
        // Includes a custom provider's injected baseUrl/key (else just the agent's env).
        env: exec.env,
      };
      // Reclaim must still return a cancelled/deleted live runtime so the runner can drain it,
      // but orchestration discovery and credential issuance use the authorizer's exact live
      // eligibility conditions. This prevents tools from appearing only to fail every call.
      const allowOrchestration =
        supportsOrchestrationCredential &&
        s.ownerId === runner.ownerId &&
        s.assignedRunnerId === runner.id &&
        s.deletedAt === null &&
        s.cancelRequestedAt === null &&
        OPEN.includes(s.status) &&
        agent?.deletedAt === null &&
        agent.enableOrchestration;
      out.push({
        sessionId: s.id,
        status: s.status as SharedRunStatus,
        provider,
        runtimeSessionId: runtime.runtimeSessionId,
        leaseOwner: s.inboxLeaseOwner ?? undefined,
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
        allowOrchestration,
        orchestrationToken: allowOrchestration
          ? await this.orchestration.issue(runner.id, s.id)
          : undefined,
      });
    }
    return { sessions: out };
  }

  /** Hand inbox activation authority from the owner observed in claim/reclaim to this process. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/takeover-leases')
  @HttpCode(200)
  async takeoverLeases(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: TakeoverTurnLeasesRequest,
    @Headers(RUNNER_CAPABILITIES_HEADER) capabilities?: string | string[],
  ): Promise<TakeoverTurnLeasesResponse> {
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    if (!leaseOwner) throw new BadRequestException('leaseOwner is required');
    const expectedLeaseOwner = parseLeaseGeneration(dto?.expectedLeaseOwner ?? undefined);
    const status = await this.prisma.$transaction(async (tx) => {
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
          status: RunStatus;
          mergeStatus: string | null;
          mergeOperationId: string | null;
          mergeOperationOwner: string | null;
          mergeRequestedAt: Date | null;
          commitStatus: string | null;
          commitOperationId: string | null;
          commitOperationOwner: string | null;
          commitRequestedAt: Date | null;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner", status,
               "merge_status" AS "mergeStatus",
               "merge_operation_id" AS "mergeOperationId",
               "merge_operation_owner" AS "mergeOperationOwner",
               "merge_requested_at" AS "mergeRequestedAt",
               "commit_status" AS "commitStatus",
               "commit_operation_id" AS "commitOperationId",
               "commit_operation_owner" AS "commitOperationOwner",
               "commit_requested_at" AS "commitRequestedAt"
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      if (!OPEN.includes(owned[0].status)) {
        throw new ConflictException('session is no longer open');
      }
      const currentOwner = owned[0].inboxLeaseOwner;
      if (
        isTerminalResumeHandoffOwner(currentOwner) &&
        !runnerSupportsCapability(capabilities, SESSION_TERMINAL_HANDOFF_V1)
      ) {
        throw new ConflictException('runner does not support terminal session handoff');
      }
      if (currentOwner === leaseOwner) return owned[0].status;
      if (
        pendingWorktreeOperationMayBeExecuting(
          owned[0].mergeStatus,
          owned[0].mergeOperationId,
          owned[0].mergeOperationOwner,
          owned[0].mergeRequestedAt,
        ) ||
        pendingWorktreeOperationMayBeExecuting(
          owned[0].commitStatus,
          owned[0].commitOperationId,
          owned[0].commitOperationOwner,
          owned[0].commitRequestedAt,
        )
      ) {
        // A different process may still be mutating this checkout/repository.
        // Claimed modern operations and ambiguous legacy NULL/NULL attempts are
        // deliberately fail-closed; never rotate their supervisor owner.
        throw new ConflictException('wait for the pending worktree operation to finish');
      }
      if (currentOwner !== expectedLeaseOwner) {
        throw new ConflictException('inbox lease owner changed; refresh the session snapshot');
      }

      const fence = owned[0].inboxLeaseGeneration ?? randomUUID();
      await tx.$executeRaw`
        INSERT INTO "inbox_lease_generation"
          ("generation", "session_id", "lease_owner", "retired_at")
        VALUES (${fence}::uuid, ${sessionId}::uuid, ${currentOwner}::uuid, now())
        ON CONFLICT ("generation") DO UPDATE
          SET "retired_at" = COALESCE("inbox_lease_generation"."retired_at", now())
        WHERE "inbox_lease_generation"."session_id" = EXCLUDED."session_id"
      `;
      // Rotating the owner means a different process now supervises this session, so the one
      // that launched its background shells and sub-agents is gone and took them with it. Clear
      // the running sets here as well as on a runtime handshake (see bgReset): `init`/`resumed`
      // only fire when an engine actually starts, which for a session that parks and is never
      // resumed is never — leaving it reading "N background processes running" for the rest of
      // its life. Takeover is the one point where the handoff is observable without the user
      // having to touch the session.
      //
      // engineTurnActive is the same kind of claim about the predecessor's engine process, and
      // dies with it for the same reason. A runner killed mid-turn (crash, restart, self-update)
      // emits no turn_end, so the flag stays true and the session reads as generating forever —
      // it is what makes a parked session count toward the running set in the UI.
      await tx.$executeRaw`
        UPDATE "session"
        SET "inbox_lease_generation" = ${fence}::uuid,
            "inbox_lease_owner" = ${leaseOwner}::uuid,
            "running_bg_shells" = '{}'::text[],
            "running_subagents" = '{}'::text[],
            "engine_turn_active" = false
        WHERE id = ${sessionId}::uuid
      `;
      await tx.$executeRaw`
        UPDATE "conversation_turn"
        SET "lease_deadline_at" = now() - interval '1 second'
        WHERE "session_id" = ${sessionId}::uuid
          AND kind IN ('message', 'shell')
          AND status = 'IN_FLIGHT'
      `;
      return owned[0].status;
    });
    this.realtime.notifyInbox(sessionId);
    return { ok: true, status: status as SharedRunStatus };
  }

  /** Activate one freshly reserved engine as this session's sole inbox consumer. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/activate-leases')
  @HttpCode(200)
  async activateLeases(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: ActivateTurnLeasesRequest,
  ): Promise<{ ok: true }> {
    const generation = parseLeaseGeneration(dto?.leaseGeneration);
    if (!generation) throw new BadRequestException('leaseGeneration is required');
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    if (!leaseOwner) throw new BadRequestException('leaseOwner is required');

    // Idempotency fast path: if this exact generation is already installed, skip the
    // FOR UPDATE lock. A reclaim storm may call takeover-leases on the same session
    // hundreds of times per minute; each call would otherwise acquire a row lock that
    // starves the claim queue's FOR UPDATE SKIP LOCKED, preventing new PENDING
    // sessions from ever being claimed.
    const preflight = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { inboxLeaseOwner: true, inboxLeaseGeneration: true, status: true },
    });
    if (
      preflight &&
      OPEN.includes(preflight.status) &&
      preflight.inboxLeaseOwner === leaseOwner &&
      preflight.inboxLeaseGeneration === generation
    ) {
      return { ok: true };
    }

    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
          status: RunStatus;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner", status
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      if (!OPEN.includes(owned[0].status)) {
        throw new ConflictException('session is no longer open');
      }
      if (owned[0].inboxLeaseOwner !== leaseOwner) {
        throw new ConflictException('this runner process does not own inbox activation');
      }
      const current = owned[0].inboxLeaseGeneration;
      if (current && current !== generation) {
        const currentState = await tx.$queryRaw<Array<{ retiredAt: Date | null }>>`
          SELECT "retired_at" AS "retiredAt"
          FROM "inbox_lease_generation"
          WHERE "generation" = ${current}::uuid AND "session_id" = ${sessionId}::uuid
        `;
        // Missing metadata is an unknown active consumer, not permission to replace it.
        if (currentState.length === 0 || currentState[0].retiredAt === null) {
          throw new ConflictException('another inbox generation is active');
        }
      }

      // Register before making the generation current. ON CONFLICT makes a lost committed
      // response idempotent, while the verification below rejects a generation that release
      // tombstoned before this delayed activation reached the Session lock.
      await tx.$executeRaw`
        INSERT INTO "inbox_lease_generation"
          ("generation", "session_id", "lease_owner")
        VALUES (${generation}::uuid, ${sessionId}::uuid, ${leaseOwner}::uuid)
        ON CONFLICT ("generation") DO NOTHING
      `;
      const registered = await tx.$queryRaw<
        Array<{
          sessionId: string;
          leaseOwner: string | null;
          retiredAt: Date | null;
        }>
      >`
        SELECT "session_id" AS "sessionId", "lease_owner" AS "leaseOwner",
               "retired_at" AS "retiredAt"
        FROM "inbox_lease_generation"
        WHERE "generation" = ${generation}::uuid
      `;
      if (
        registered.length !== 1 ||
        registered[0].sessionId !== sessionId ||
        registered[0].leaseOwner !== leaseOwner ||
        registered[0].retiredAt !== null
      ) {
        throw new ConflictException('inbox generation has already been retired or reused');
      }
      await tx.$executeRaw`
        UPDATE "session"
        SET "inbox_lease_generation" = ${generation}::uuid
        WHERE id = ${sessionId}::uuid
      `;
      // A legacy NULL poll or a predecessor may have leased after reclaim but before this
      // activation acquired the Session lock. Make every non-current executable turn visible
      // now, rather than letting it block the new engine for the normal five-minute deadline.
      await tx.$executeRaw`
        UPDATE "conversation_turn"
        SET "lease_deadline_at" = now() - interval '1 second'
        WHERE "session_id" = ${sessionId}::uuid
          AND kind IN ('message', 'shell')
          AND status = 'IN_FLIGHT'
          AND "lease_generation" IS DISTINCT FROM ${generation}::uuid
      `;
    });
    return { ok: true };
  }

  /** Expire input leases abandoned when a warm runtime is evicted. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/release-leases')
  @HttpCode(200)
  async releaseLeases(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto?: ReleaseTurnLeasesRequest,
  ): Promise<{ ok: true }> {
    const generation = parseLeaseGeneration(dto?.leaseGeneration);
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    await this.prisma.$transaction(async (tx) => {
      // Use the same Session row lock as dequeueTurn. Whichever request arrives
      // last observes the other's generation, so a delayed release from a dead
      // process can never expire its replacement's lease.
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner" FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      if (generation) {
        // Upsert a tombstone even when release beats activation to the lock. A delayed
        // activate(G1) then observes retired_at and cannot make G1 current again.
        await tx.$executeRaw`
          INSERT INTO "inbox_lease_generation"
            ("generation", "session_id", "lease_owner", "retired_at")
          VALUES (${generation}::uuid, ${sessionId}::uuid, ${leaseOwner}::uuid, now())
          ON CONFLICT ("generation") DO UPDATE
            SET "retired_at" = COALESCE("inbox_lease_generation"."retired_at", now())
          WHERE "inbox_lease_generation"."session_id" = EXCLUDED."session_id"
        `;
      }
      // A legacy runner omits both generation and owner. Preserve its NULL session state so
      // the replacement legacy engine can continue polling; modern runners are fenced by
      // takeover before they start a supervisor and always release a concrete generation.
      await tx.$executeRaw`
        UPDATE "conversation_turn"
        SET "lease_deadline_at" = now() - interval '1 second'
        WHERE "session_id" = ${sessionId}::uuid
          AND kind IN ('message', 'shell')
          AND status = 'IN_FLIGHT'
          AND "lease_generation" IS NOT DISTINCT FROM ${generation}::uuid
      `;
    });
    this.realtime.notifyInbox(sessionId);
    return { ok: true };
  }

  /** Replace a missing/stale in-process proof without restarting the session runtime. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/orchestration-credential')
  @HttpCode(200)
  async refreshOrchestrationCredential(
    @CurrentRunner() runner: { id: string; ownerId: string },
    @Param('id', PublicIdPipe) sessionId: string,
  ): Promise<OrchestrationCredentialResponse> {
    return { orchestrationToken: await this.orchestration.reissue(runner, sessionId) };
  }

  /** Per-session long-poll: the next user turn to feed the live claude process. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/inbox')
  async inbox(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Query('leaseGeneration') leaseGeneration?: string,
  ): Promise<RunInboxResponse> {
    const generation = parseLeaseGeneration(leaseGeneration);
    const deadline = Date.now() + INBOX_LONG_POLL_MS;
    for (;;) {
      const turn = await this.dequeueTurn(sessionId, runner.id, generation);
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
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('attId', PublicIdPipe) attId: string,
  ): Promise<StreamableFile> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const att = await this.prisma.attachment.findFirst({
      where: { id: attId, sessionId },
      select: { data: true, mimeType: true },
    });
    if (!att) throw new NotFoundException('attachment not found');
    const data = Buffer.from(att.data);
    return new StreamableFile(data, {
      type: att.mimeType,
      disposition: 'inline',
      length: data.length,
    });
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
    @Param('id', PublicIdPipe) sessionId: string,
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
    @Param('id', PublicIdPipe) sessionId: string,
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
   * message, and PENDING or an expired IN_FLIGHT lease (at-least-once). Executable
   * messages are gated on the claim path having already set the Session to RUNNING.
   */
  private async dequeueTurn(
    sessionId: string,
    runnerId: string,
    leaseGeneration: string | null,
  ): Promise<RunInboxResponse | null> {
    return this.prisma.$transaction(async (tx) => {
      // More than one inbox poller can briefly exist around a warm activation or runner
      // restart. Serialize them on the Session row so their NOT EXISTS(in-flight) checks
      // cannot both lease different messages from the same snapshot.
      const owned = await tx.$queryRaw<
        Array<{
          id: string;
          inboxLeaseGeneration: string | null;
          inboxLeaseOwner: string | null;
          status: RunStatus;
        }>
      >`
        SELECT id, "inbox_lease_generation" AS "inboxLeaseGeneration",
               "inbox_lease_owner" AS "inboxLeaseOwner", status
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runnerId}::uuid
        FOR UPDATE
      `;
      if (owned.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      // Check lifecycle before generation compatibility. In particular, a legacy
      // NULL poller must receive the same terminal 409 as a modern engine instead
      // of taking the historical empty-poll path forever.
      if (!OPEN.includes(owned[0].status)) {
        throw new ConflictException('session is no longer open');
      }
      if (owned[0].inboxLeaseGeneration !== leaseGeneration) {
        // A modern poller carries a concrete generation. Once takeover/activation has
        // replaced it, returning an empty poll would let the dead engine keep looping
        // indefinitely. Tell it explicitly that its ownership was lost. Legacy NULL
        // pollers retain the old empty-poll compatibility behavior during upgrades.
        if (leaseGeneration) {
          throw new ConflictException('inbox lease generation is no longer current');
        }
        return null;
      }
      if (leaseGeneration) {
        const active = await tx.$queryRaw<Array<{ generation: string }>>`
          SELECT "generation"
          FROM "inbox_lease_generation"
          WHERE "generation" = ${leaseGeneration}::uuid
            AND "session_id" = ${sessionId}::uuid
            AND "lease_owner" IS NOT DISTINCT FROM ${owned[0].inboxLeaseOwner}::uuid
            AND "retired_at" IS NULL
        `;
        if (active.length === 0) {
          throw new ConflictException('inbox lease generation is missing or retired');
        }
      }
      const rows = await tx.$queryRaw<Array<{ id: string; seq: number; kind: string; content: string | null }>>`
        UPDATE "conversation_turn"
          SET status = 'IN_FLIGHT',
              "delivered_at" = now(),
              "lease_deadline_at" = now() + (${INBOX_LEASE_MS} * interval '1 millisecond'),
              "lease_generation" = ${leaseGeneration}::uuid
        WHERE id = (
          SELECT turn.id FROM "conversation_turn" turn
          WHERE turn."session_id" = ${sessionId}::uuid
            AND (
              -- interrupt/end land immediately, even mid-message (interrupt is the point).
              -- diff is read-only and runtime-independent, so it may land while idle too.
              (turn."kind" IN ('interrupt', 'end', 'diff')
                AND (turn."status" = 'PENDING' OR (turn."status" = 'IN_FLIGHT' AND turn."lease_deadline_at" < now())))
              -- A reload is ordered between executable turns, but does not itself consume
              -- an active-turn slot. A cold runtime can leave it queued until the next claim.
              OR (turn."kind" = 'reload' AND turn."status" = 'PENDING' AND NOT EXISTS (
                SELECT 1 FROM "conversation_turn" inflight
                WHERE inflight."session_id" = ${sessionId}::uuid
                  AND inflight."kind" IN ('message', 'shell')
                  AND inflight."status" = 'IN_FLIGHT'
              ))
              -- User executable turns are deliverable only after claim changed the Session
              -- to RUNNING. An AWAITING_INPUT process may remain warm, but its inbox cannot
              -- bypass maxConcurrent merely because it is already resident.
              OR (turn."kind" IN ('message', 'shell')
                AND EXISTS (
                  SELECT 1 FROM "session" active
                  WHERE active.id = ${sessionId}::uuid
                    AND active.status = 'RUNNING'
                    AND active."cancel_requested_at" IS NULL
                )
                AND (
                  (turn."status" = 'IN_FLIGHT' AND turn."lease_deadline_at" < now())
                  OR (turn."status" = 'PENDING' AND NOT EXISTS (
                    SELECT 1 FROM "conversation_turn" inflight
                    WHERE inflight."session_id" = ${sessionId}::uuid
                      AND inflight."kind" IN ('message', 'shell')
                      AND inflight."status" = 'IN_FLIGHT'
                  ))
                ))
            )
          ORDER BY (CASE WHEN turn."kind" IN ('interrupt', 'end', 'diff') THEN 0 WHEN turn."kind" = 'reload' THEN 1 ELSE 2 END), turn."seq" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, seq, kind, content
      `;
      if (rows.length === 0) return null;
      const t = rows[0];
      let attachments: TurnAttachment[] | undefined;
      let content = t.content ?? undefined;
      if (t.kind === 'message') {
        // A message turn that already produced runtime output is a lease re-delivery.
        // Resume with a continuation nudge instead of replaying its side effects.
        const started = await tx.runEvent.findFirst({
          where: {
            turnId: t.id,
            OR: [
              { type: { in: [...RUNTIME_STARTED_EVENT_TYPES] } },
              {
                type: 'system',
                payload: {
                  path: ['subtype'],
                  equals: RUNTIME_STARTED_SYSTEM_SUBTYPE,
                },
              },
            ],
          },
          select: { id: true },
        });
        if (started) {
          content = buildResumeContinuation(t.content);
        } else {
          const atts = await tx.attachment.findMany({
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
      } else if (t.kind !== 'shell') {
        // Control turns are fire-and-forget: ack on delivery so a stale one cannot
        // repeatedly jump ahead of real messages after each lease window.
        await tx.conversationTurn.updateMany({
          where: { id: t.id, status: { not: 'ANSWERED' } },
          data: { status: 'ANSWERED', answeredAt: new Date() },
        });
      }
      return {
        turnId: t.id,
        seq: t.seq,
        kind: t.kind as ConversationTurnKind,
        content,
        attachments,
        env: t.kind === 'reload' ? await this.reloadProviderEnv(tx, sessionId, t.content) : undefined,
      };
    });
  }

  /**
   * The environment a `reload` re-spawns with, for the one reload that needs it: a provider switch
   * (see SessionsService.updateConfig). Every other reload — model, permission mode, effort — runs
   * on the environment the engine already has, and returns undefined so the runner leaves its
   * process alone beyond the flags.
   *
   * Resolved here rather than stored on the turn: the injected environment carries the provider's
   * decrypted key, and `conversation_turn.content` is neither encrypted nor short-lived. The queued
   * turn names the provider; this reads the session as it stands now and builds the rest.
   */
  private async reloadProviderEnv(
    tx: Prisma.TransactionClient,
    sessionId: string,
    content: string | null,
  ): Promise<Record<string, string> | undefined> {
    let declared: unknown;
    try {
      declared = (JSON.parse(content ?? '{}') as { provider?: unknown }).provider;
    } catch {
      return undefined;
    }
    if (typeof declared !== 'string' || !declared) return undefined;
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: {
        ownerId: true,
        model: true,
        provider: true,
        providerBuiltin: true,
        usesRuntimeDefaultModel: true,
        agent: { select: { model: true, env: true } },
        assignedRunner: { select: { runtimeDefaultModels: true, modelCatalog: true } },
      },
    });
    if (!session) return undefined;
    const customRow = isBuiltinProvider(session.provider, session.providerBuiltin)
      ? null
      : await tx.modelProvider.findFirst({
          where: {
            slug: session.provider!,
            OR: [{ ownerId: null }, { ownerId: session.ownerId }],
          },
        });
    const exec = resolveProviderExec({
      declaredProvider: session.provider,
      declaredProviderBuiltin: session.providerBuiltin,
      customRow,
      sessionModel: session.model,
      usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
      runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
      agentModel: session.agent?.model,
      modelCatalog: session.assignedRunner?.modelCatalog,
      agentEnv: session.agent?.env as Record<string, string> | null,
    });
    // A built-in engine authenticates itself, so moving onto one injects nothing — but the
    // previous provider's variables must still go, which an empty map is how the runner is told.
    return exec.env ?? {};
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
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: ApprovalCreateRequest,
  ): Promise<{ id: string; status: ApprovalStatus }> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const existing = dto.toolUseId
      ? await this.prisma.approval.findUnique({
          where: {
            sessionId_toolUseId: { sessionId, toolUseId: dto.toolUseId },
          },
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
    @Param('id', PublicIdPipe) sessionId: string,
    @Param('approvalId', PublicIdPipe) approvalId: string,
  ): Promise<ApprovalDecisionResponse> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const deadline = Date.now() + APPROVAL_LONG_POLL_MS;
    for (;;) {
      const a = await this.prisma.approval.findFirst({
        where: { id: approvalId, sessionId },
      });
      if (!a)
        return {
          id: approvalId,
          status: 'DENIED',
          behavior: 'deny',
          message: 'approval not found',
        };
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

  /** A single interactive turn finished; retain or release its active-turn slot. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/turn-complete')
  async turnComplete(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: TurnCompleteRequest,
  ) {
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    const usage = dto.usage;
    const finalized = await this.prisma.$transaction(async (tx) => {
      // Serialize completion with createTurn's enqueue transition. Whichever locks the
      // Session first determines whether a follow-up is already queued; this prevents the
      // lost-wakeup state AWAITING_INPUT + PENDING conversation turn. The same lock also
      // fences every write below to the runner process that currently owns the Session.
      await this.lockSessionLeaseOwner(tx, sessionId, runner.id, leaseOwner);
      const current = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
          status: true,
          taskId: true,
          mergeStatus: true,
          mergedSourceSha: true,
        },
      });
      // A turn that failed mid-run (e.g. an API/content-filter error the agent couldn't
      // recover from — the runner reports such turns as FAILED) would otherwise park at
      // AWAITING_INPUT, which is indistinguishable from an ordinary idle session: the list
      // says "Waiting for your reply" and the failure is invisible until you open the
      // session. So the run outcome settles FAILED — that IS what happened to the run, and
      // it's what the list must show. The session stays resumable, so retrying is still one
      // message away. A task-bound session additionally reclaims its task as FAILED (it
      // would otherwise sit IN_PROGRESS with nothing watching).
      const failSession = dto.status === RunStatus.FAILED;
      const failTask = failSession && !!current.taskId;
      // Keep this formerly post-transaction cleanup behind the same process fence. It is
      // valid for duplicate completions too, so apply it before the idempotent ack check.
      let branchMerged = dto.branchMerged;
      if (dto.branchMerged === false && current.mergeStatus === 'merged') {
        if (current.mergedSourceSha && (!dto.branchSha || current.mergedSourceSha === dto.branchSha)) {
          // A rebase merge can produce a different patch-id from its source commit when it
          // adapts overlapping target changes. The exact source tip proves this is still the
          // branch snapshot that was merged, so keep the successful state authoritative. A
          // missing report SHA is inconclusive (legacy runner or transient ref lookup failure),
          // so it must not erase an exact marker captured by the successful merge.
          branchMerged = true;
        } else {
          const mergedSourceSha = current.mergedSourceSha ?? null;
          await tx.session.updateMany({
            where: {
              id: sessionId,
              assignedRunnerId: runner.id,
              mergeStatus: 'merged',
              mergedSourceSha,
            },
            data: {
              mergeStatus: null,
              mergeOperationId: null,
              mergeOperationOwner: null,
              mergeError: null,
              mergedSourceSha: null,
            },
          });
        }
      }
      // Idempotent ack: only the first turn-complete for this turn applies.
      const ack = await tx.conversationTurn.updateMany({
        where: { id: dto.turnId, sessionId, status: { not: 'ANSWERED' } },
        data: { status: 'ANSWERED', answeredAt: new Date() },
      });
      if (ack.count === 0) {
        return { applied: false, status: current.status, failSession };
      }
      // A `!`-shell turn runs on the runner, not in claude, so it must NOT advance numTurns:
      // that counter gates --resume on respawn (queue.buildSession). Counting a shell turn
      // would make a shell-first session (claude never received a message) try to --resume a
      // conversation that was never established, failing with "No conversation found".
      const completed = await tx.conversationTurn.findUnique({
        where: { id: dto.turnId },
        select: { kind: true },
      });
      const turnInc = completed?.kind === 'shell' ? 0 : (dto.numTurns ?? 1);
      // If a follow-up arrived before this completion acquired the Session lock, the
      // current active slot passes directly to it and the inbox may deliver it next. With
      // no executable follow-up, release the slot while the runtime remains warm.
      const pendingExecutable = failSession
        ? 0
        : await tx.conversationTurn.count({
            where: {
              sessionId,
              kind: { in: ['message', 'shell'] },
              status: 'PENDING',
            },
          });
      const nextStatus = failSession
        ? RunStatus.FAILED
        : statusAfterTurnCompleted(pendingExecutable > 0);
      // Settle + bill only if this is still the active turn and is not being torn down,
      // so a late/retried completion cannot resurrect a finalized session or double-bill.
      const parked = await tx.session.updateMany({
        where: {
          id: sessionId,
          cancelRequestedAt: null,
          status: RunStatus.RUNNING,
        },
        data: {
          status: nextStatus,
          // On a failed turn claude is still alive (the turn errored, the process didn't
          // exit), so finalizing FAILED here would leak its runner concurrency slot — the
          // process lingers, holding a slot, until the runner restarts. Set
          // cancelRequestedAt so the next heartbeat's cancel-drain tells the runner to
          // tear that process down and reclaim the slot (mirrors reaper forceFinalize).
          ...(failSession
            ? {
                error: dto.result || 'run failed',
                finishedAt: new Date(),
                cancelRequestedAt: new Date(),
              }
            : {}),
          // Live worktree state for the composer's status bar, refreshed each turn (the
          // runner reports the worktree's uncommitted diff vs base on every turn-complete).
          isolationStatus: dto.isolationStatus ?? undefined,
          ...(dto.changedFiles !== undefined
            ? {
                changedFiles: dto.changedFiles as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(dto.worktreeDirty !== undefined ? { worktreeDirty: dto.worktreeDirty } : {}),
          // Whether the branch already landed in main — the turn-end snapshot an idle session
          // shows, so the bar offers "✓ In main" not a redundant Merge (older runners omit it).
          ...(branchMerged !== undefined ? { branchMerged } : {}),
          // The worktree's actual HEAD branch → flags divergence / offers Adopt (older runners omit).
          ...(dto.worktreeBranch !== undefined ? { worktreeBranch: dto.worktreeBranch } : {}),
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
      if (parked.count === 0) {
        const latest = await tx.session.findUnique({
          where: { id: sessionId },
          select: { status: true },
        });
        return {
          applied: false,
          status: latest?.status ?? current.status,
          failSession,
        };
      }
      if (failSession) {
        await retireSessionInboxGeneration(tx, sessionId);
      }
      // Per-file unified diffs to the side table (never on the session row, so the detail/
      // list payload stays small) — fetched on demand when the user opens a file's diff.
      if (dto.changedDiff !== undefined) {
        await tx.sessionDiff.upsert({
          where: { sessionId },
          create: {
            sessionId,
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
          update: {
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
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
      if (failSession) {
        // Drain queued turns so nothing can be leased after the session ends.
        await tx.conversationTurn.updateMany({
          where: { sessionId, status: { not: 'ANSWERED' } },
          data: { status: 'ANSWERED', answeredAt: new Date() },
        });
      }
      if (failTask) {
        // Surface the abandoned task for a human.
        await reclaimStalledTask(tx, current.taskId!, TaskStatus.FAILED);
        await postRunFailureComment(tx, current.taskId!, dto.result || 'run failed');
      }
      return { applied: true, status: nextStatus, failSession };
    });
    if (finalized.failSession) {
      // Only announce the terminal status if this call actually finalized the session
      // (a late/duplicate turn-complete for an already-ended session is a no-op).
      if (finalized.applied) {
        this.realtime.publish(sessionId, {
          seq: Number.MAX_SAFE_INTEGER,
          type: RunEventType.STATUS,
          ts: new Date().toISOString(),
          payload: { status: RunStatus.FAILED, final: true },
        });
      }
      return { ok: true, status: finalized.status };
    }
    // RUNNING means the already-held slot passes to a queued follow-up. AWAITING_INPUT
    // still wakes control turns (reload/diff/end), while executable messages remain gated
    // until a future claim changes the Session back to RUNNING.
    this.realtime.notifyInbox(sessionId);
    if (finalized.applied && finalized.status === RunStatus.AWAITING_INPUT) {
      // A runner slot just became available; wake claim long-polls immediately instead
      // of leaving unrelated PENDING sessions to the periodic retry fallback.
      this.queue.notifySessionQueued();
    }
    return { ok: true, status: finalized.status };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/events')
  @HttpCode(202)
  async events(@CurrentRunner() runner: { id: string }, @Param('id', PublicIdPipe) sessionId: string, @Body() batch: RunEventBatch) {
    const leaseOwner = parseLeaseGeneration(batch?.leaseOwner);
    // Sanitized here, at the edge, so nothing downstream can carry a byte Postgres refuses:
    // every write below — run_event.payload, tool_call, the denormalized preview columns — is
    // derived from this array, and one NUL in one tool_result used to fail the batch and wedge
    // the session's stream behind it for good. See strip-nul.ts.
    const events = stripNul(batch?.events ?? []);

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
    const session = await this.prisma.$transaction(async (tx) => {
      // Take the Session lock before any event-side write. Besides fencing stale runner
      // processes, a consistent lock order prevents event writes from racing a takeover
      // outside the transaction and later deadlocking when they touch Session.
      await this.lockSessionLeaseOwner(tx, sessionId, runner.id, leaseOwner);
      const session = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { status: true, runtimeSessionId: true },
      });
      // The owner fence alone is insufficient when the same runner process
      // survives a control-plane terminal transition. Reject before every event-
      // derived write, including empty and streaming-only batches. The runner drains
      // a task-failure tail through a bounded send barrier before terminalizing it.
      if (!OPEN.includes(session.status)) {
        throw new ConflictException('session is no longer open');
      }
      if (durable.length > 0) {
        await tx.runEvent.createMany({
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
        // Persisted conversation/background activity is liveness. Session-level system events
        // are different: every reclaimed idle session emits init/resumed when its runner restarts,
        // and counting that handshake would move every waiting session to "now" and scramble the
        // recency sort. OPEN deliberately includes PENDING because a buffered tail from the prior
        // turn may arrive after a concurrent send moved AWAITING_INPUT -> PENDING.
        if (hasSessionActivity(durable)) {
          await tx.session.updateMany({
            where: {
              id: sessionId,
              cancelRequestedAt: null,
              status: { in: OPEN },
            },
            data: { lastTurnAt: new Date() },
          });
        }
      }

      // Dynamic runtimes report their session id in an init/resumed event; unlike Claude
      // (seeded at session creation) it's otherwise only persisted at /turn-complete.
      // Capture it as soon as it lands so the reaper's startup
      // watchdog (reaper.service.ts) can tell a live-but-slow first turn from a runtime
      // that never came up — without this a first turn longer than the startup grace is
      // force-failed as "<runtime> runtime not initialized". Fill only while unset (the id is
      // stable per session), so this is a one-shot, retry-idempotent write.
      if (!session.runtimeSessionId) {
        const runtimeId = runtimeInitSessionId(durable);
        if (runtimeId) {
          await tx.session.updateMany({
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
      let frontier: { seq: number; tool: string | null } | null = null;
      // The pending question, denormalized alongside the tool: the message text when a user turn
      // arrives (a turn just started, no reply yet) → the list shows it while awaiting the reply;
      // an event that *answers* it clears it, flipping the row back to the reply once it lands.
      // Everything else leaves it standing — an interrupt, a turn ending or a system handshake
      // ends the turn without answering, and clearing on those left a session interrupted before
      // its first reply with no preview at all. `undefined` = no event in this batch decided
      // either way, so the stored value stays. Stored full; the list query truncates it
      // (left(…, PREVIEW_LEN)).
      let pendingUserText: string | null | undefined;
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
        if (e.type === RunEventType.USER) {
          pendingUserText =
            (
              (e.payload as { text?: string; content?: string } | null)?.text ??
              (e.payload as { content?: string } | null)?.content ??
              ''
            ).trim() || null;
        } else if (ANSWERS_USER_TURN.has(e.type)) {
          pendingUserText = null;
        }
        frontier = { seq: e.seq, tool };
      }
      // A reply that is only the provider saying it cannot answer right now — the account's
      // quota spent, or the API overloaded — is the failure that fixes itself: the same
      // message succeeds once the window rolls over or the far side recovers. Arm a retry for
      // that moment. Detected here rather than in the runner so it also covers runners too old
      // to know about this — they self-update on their own schedule and outlive a release.
      const retry = lastAssistant
        ? await this.retryPlanFor(tx, sessionId, runner.id, lastAssistant.text)
        : {};
      // Whether the engine is generating right now — see Session.engineTurnActive. Tracked
      // separately from the frontier above because it must survive a tool_result (a tool
      // finishing clears lastToolUse but the turn runs on) and because `status` cannot answer
      // it: a turn the runtime started for itself never reaches /turn-complete, so the session
      // stays AWAITING_INPUT for its whole duration.
      const engineTurnActive = engineTurnActiveAfter(durable);
      if (lastAssistant || frontier || engineTurnActive !== undefined) {
        await tx.session.update({
          where: { id: sessionId },
          data: {
            ...(lastAssistant ? { lastAssistantText: lastAssistant.text } : {}),
            ...(frontier ? { lastToolUse: frontier.tool } : {}),
            ...(engineTurnActive !== undefined ? { engineTurnActive } : {}),
            // undefined = nothing in this batch either asked or answered; keep the stored
            // message rather than writing null over it.
            ...(pendingUserText !== undefined ? { lastUserText: pendingUserText } : {}),
            ...retry,
          },
        });
      }

      const toolUses = events.filter((e) => e.type === RunEventType.TOOL_USE);
      if (toolUses.length > 0) {
        await tx.toolCall.createMany({
          data: toolUses.map((e) => ({
            sessionId,
            name: String((e.payload as Record<string, unknown>).name ?? 'unknown'),
            input: ((e.payload as Record<string, unknown>).input ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            startedAt: new Date(e.ts),
          })),
        });
      }

      // Maintain the running background-shell set (Session.runningBgShells), which drives the
      // "Background running" status on the list + header. Added on a background launch (keyed by
      // its tool_use id), removed on that task's terminal <task-notification> — which the runner
      // also synthesizes when the launching runtime stops, since its children die with it — and
      // cleared on a respawn handshake (see bgReset).
      // Two tools launch one: Bash with run_in_background, and Monitor, a watcher that has no such
      // flag because backgrounding is all it does. Both report in through the same
      // <task-notification> carrying the launch tool_use id (a Monitor's per-event pings carry
      // neither id nor status, so only its terminal one clears the set), which is what lets
      // bgEnded below retire either kind without knowing which it was.
      // Atomic array ops stay idempotent under event-batch retries.
      const bgStarted = events
        .filter((e) => {
          if (e.type !== RunEventType.TOOL_USE) return false;
          const name = (e.payload as { name?: string }).name;
          if (name === 'Monitor') return true;
          return (
            name === 'Bash' &&
            (e.payload as { input?: { run_in_background?: boolean } }).input?.run_in_background === true
          );
        })
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
      // A respawn handshake means a fresh provider process: whatever the previous one had running
      // died with it. Only `resumed` qualifies, because the runner emits that one itself, exactly
      // when it restarts an engine in place.
      //
      // `init` used to count too, as a backstop for a runner killed outright. It cannot: Claude
      // Code emits an `init` at the head of EVERY query, including the self-driven turns it starts
      // for a background-task notification (see Session.engineTurnActive). So the wake-up that
      // proved a background task was alive was also what erased the record of it, and a session
      // watching a live Monitor reported no background work at all. The crash case is covered
      // where the handoff is actually observable: /takeover-leases clears the same two sets when a
      // different process takes the session over, and every claim and reclaim goes through it.
      const bgReset = events.some(
        (e) =>
          e.type === RunEventType.SYSTEM &&
          String((e.payload as { subtype?: unknown }).subtype ?? '') === 'resumed',
      );
      if (bgReset) {
        await tx.session.update({
          where: { id: sessionId },
          data: { runningBgShells: [], runningSubagents: [] },
        });
      }
      for (const id of bgStarted) {
        await tx.$executeRaw`UPDATE "session" SET "running_bg_shells" = array_append(array_remove("running_bg_shells", ${id}), ${id}) WHERE "id" = ${sessionId}::uuid`;
      }
      for (const id of subStarted) {
        await tx.$executeRaw`UPDATE "session" SET "running_subagents" = array_append(array_remove("running_subagents", ${id}), ${id}) WHERE "id" = ${sessionId}::uuid`;
      }
      // A terminal background_task id belongs to either a background shell or a sub-agent;
      // array_remove is a no-op on the set that doesn't hold it, so clear from both.
      for (const id of bgEnded) {
        await tx.$executeRaw`UPDATE "session" SET "running_bg_shells" = array_remove("running_bg_shells", ${id}), "running_subagents" = array_remove("running_subagents", ${id}) WHERE "id" = ${sessionId}::uuid`;
      }
      // Clear synchronously-completed sub-agents in one guarded write. The `&&` overlap check means
      // ordinary (non-sub-agent) tool_results — the vast majority — match no rows and never rewrite
      // the hot session row.
      if (subEnded.length > 0) {
        await tx.$executeRaw`
        UPDATE "session"
        SET "running_subagents" = ARRAY(
          SELECT unnest("running_subagents") EXCEPT SELECT unnest(${subEnded}::text[])
        )
        WHERE "id" = ${sessionId}::uuid AND "running_subagents" && ${subEnded}::text[]`;
      }
      return session;
    });

    // Broadcast to live subscribers while the session is open;
    // once finalized, don't let late/replayed events spam the live stream — they
    // remain in the persisted transcript and appear on replay. NB: must include
    // AWAITING_INPUT, not just RUNNING — the runner emits a turn's final batch
    // (last text_delta + the authoritative `assistant` + `turn_end`) into its 250ms
    // buffer, then immediately calls /turn-complete, which parks the session at
    // AWAITING_INPUT. So that buffered batch almost always arrives here AFTER the
    // park; gating on RUNNING alone dropped every turn's tail from the live stream.
    // PENDING matters for the same reason when a new message races that buffered tail.
    if (OPEN.includes(session.status)) {
      for (const e of events) {
        // Persisted above either way — but a `system` progress ping renders as nothing on every
        // client, so spending a frame on it only costs the reader bandwidth. The replay paths
        // drop the same events (notNoiseSql), so live and replayed transcripts agree.
        if (isNoiseSystemEvent(e)) continue;
        this.realtime.publish(sessionId, e);
      }
    }
    return { ok: true };
  }

  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/finalize')
  async finalize(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: RunFinalizeRequest,
  ): Promise<RunFinalizeResponse> {
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner);
    // Finalize in ONE row-locked transaction. Complete/remove/reaper also write this row,
    // so the locked re-read is the only snapshot allowed to decide the final status and
    // checkout lifetime. The process fence is evaluated from that same locked snapshot,
    // so a predecessor cannot finalize after takeover. Billing is accrued per-turn by
    // /turn-complete.
    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lockSessionLeaseOwner(tx, sessionId, runner.id, leaseOwner);
      if (!TERMINAL.includes(dto.status as RunStatus)) {
        throw new BadRequestException('finalization status must be terminal');
      }
      const current = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
      });

      // If cancel/end won the row lock, its reason is authoritative regardless of what
      // the runner reports. TASK_DONE settles SUCCEEDED; task-cancel/user-end/idle and
      // hard complete/delete/cancel settle CANCELLED through the fallback.
      const effectiveStatus: RunStatus = current.cancelRequestedAt
        ? ((gracefulEndStatus(current.endReason) as RunStatus | null) ?? RunStatus.CANCELLED)
        : (dto.status as RunStatus);
      // Filing timestamps are canonical for new rows; endReason checks keep legacy rows
      // safe. Only Open sessions retain their checkout for a future resume.
      const keepCheckout =
        (current.completedAt ?? current.archivedAt) == null &&
        current.deletedAt == null &&
        current.endReason !== SessionEndReason.COMPLETED &&
        current.endReason !== SessionEndReason.DELETED;

      // Only a LIVE session is finalized (updateMany count); duplicate/late completion
      // is a safe no-op but still returns the result derived from this locked snapshot.
      const res = await tx.session.updateMany({
        where: { id: sessionId, status: { in: LIVE } },
        data: {
          status: effectiveStatus,
          result: dto.result,
          error: dto.error,
          // `claudeSessionId` is a legacy alias older runners still send; both name the same
          // id, so it only serves as a fallback here and is never persisted on its own.
          runtimeSessionId: dto.runtimeSessionId ?? dto.claudeSessionId ?? undefined,
          finishedAt: new Date(),
          // Worktree isolation outcome reported by the runner: the branch it committed
          // the work to, the base it forked from, what it did (worktree/shared-nogit),
          // and the per-file diff summary. Each left untouched when the runner omits it.
          branch: dto.branch ?? undefined,
          baseSha: dto.baseSha ?? undefined,
          // The worktree's actual HEAD branch at completion → the bar flags divergence from the
          // tracked `branch` / offers Adopt for a session that finished on a checkout -b branch.
          ...(dto.worktreeBranch !== undefined ? { worktreeBranch: dto.worktreeBranch } : {}),
          isolationStatus: dto.isolationStatus ?? undefined,
          ...(dto.changedFiles !== undefined
            ? {
                changedFiles: dto.changedFiles as unknown as Prisma.InputJsonValue,
              }
            : {}),
          // Candidate branches for the ended session's "Merge to…" dropdown (older runners omit it).
          ...(dto.mergeTargets !== undefined ? { mergeTargets: dto.mergeTargets } : {}),
          // finalizeWorktree committed everything onto the branch before /finalize, so the
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
      if (res.count === 0) return { finalized: false, effectiveStatus, keepCheckout };
      await retireSessionInboxGeneration(tx, sessionId);
      // Persist the committed branch's per-file diffs to the side table (see turn-complete) —
      // off the session payload, fetched on demand when a file's diff is opened.
      if (dto.changedDiff !== undefined) {
        await tx.sessionDiff.upsert({
          where: { sessionId },
          create: {
            sessionId,
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
          update: {
            patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
          },
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
      if (current.taskId && effectiveStatus !== RunStatus.SUCCEEDED) {
        await reclaimStalledTask(
          tx,
          current.taskId,
          effectiveStatus === RunStatus.FAILED ? TaskStatus.FAILED : TaskStatus.OPEN,
        );
        // Genuine failure (not a user cancel): leave a note on the task explaining it.
        if (effectiveStatus === RunStatus.FAILED) {
          await postRunFailureComment(tx, current.taskId, dto.error || dto.result || 'run failed');
        }
      }
      return { finalized: true, effectiveStatus, keepCheckout };
    });
    if (!outcome.finalized) return { ok: true, keepCheckout: outcome.keepCheckout };

    this.realtime.publish(sessionId, {
      seq: Number.MAX_SAFE_INTEGER,
      type: RunEventType.STATUS,
      ts: new Date().toISOString(),
      payload: { status: outcome.effectiveStatus, final: true },
    });
    return { ok: true, keepCheckout: outcome.keepCheckout };
  }

  /** @deprecated Runner protocol alias retained for binaries predating `/finalize`. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/complete')
  complete(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: RunFinalizeRequest,
  ): Promise<RunFinalizeResponse> {
    return this.finalize(runner, sessionId, dto);
  }

  /** Startup worktree GC support: given the session ids of leftover checkouts on the runner,
   *  return which are safe to remove. A checkout is kept while its session still exists and is
   *  neither Completed nor deleted — it stays resumable, so idle-parked sessions
   *  survive a runner restart. Everything else (Completed, deleted, or missing) is
   *  removable leftover. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/worktrees-removable')
  async worktreesRemovable(
    @CurrentRunner() _runner: { id: string },
    @Body() dto: WorktreesRemovableRequest,
  ): Promise<WorktreesRemovableResponse> {
    const ids = (dto.ids ?? []).slice(0, 1000);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const valid = ids.filter((id) => UUID.test(id));
    const keepRows = valid.length
      ? await this.prisma.session.findMany({
          where: {
            id: { in: valid },
            completedAt: null,
            archivedAt: null,
            deletedAt: null,
          },
          select: { id: true },
        })
      : [];
    const keep = new Set(keepRows.map((r) => r.id));
    return { removable: ids.filter((id) => !keep.has(id)) };
  }

  /** Outcome of a heartbeat-delivered MergeCommand — persist it so the worktree status bar
   *  can show merged ✓ / conflict / error. mergedAt + cleared error on success; the message
   *  (git stderr / failed precondition) is kept for conflict/error. `released` is not an
   *  outcome: a runner that drained before touching the repo hands the claim back. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/merge-result')
  async mergeResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SessionMergeResultRequest,
  ) {
    if (
      dto?.status !== 'merged' &&
      dto?.status !== 'conflict' &&
      dto?.status !== 'error' &&
      dto?.status !== 'released'
    ) {
      throw new BadRequestException('invalid merge result status');
    }
    const operationId = parseLeaseGeneration(dto?.operationId, 'operationId');
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner, 'leaseOwner');
    if (!!operationId !== !!leaseOwner) {
      throw new BadRequestException('operationId and leaseOwner must be provided together');
    }
    const released = dto.status === 'released';
    // Handing a claim back is only meaningful for the owner-bearing protocol: a legacy
    // request has no recorded owner to clear.
    if (released && !operationId) {
      throw new BadRequestException('released requires the claimed operation');
    }
    const merged = dto.status === 'merged';
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          status: RunStatus;
          inboxLeaseOwner: string | null;
          mergeStatus: string | null;
          mergeOperationId: string | null;
          mergeOperationOwner: string | null;
        }>
      >`
        SELECT status, "inbox_lease_owner" AS "inboxLeaseOwner",
               "merge_status" AS "mergeStatus",
               "merge_operation_id" AS "mergeOperationId",
               "merge_operation_owner" AS "mergeOperationOwner"
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      const current = locked[0];
      // A terminal merge has no live supervisor and is claimed by the operation owner.
      // An open merge additionally remains fenced to the current Session owner.
      const legacyAttempt =
        !operationId &&
        !leaseOwner &&
        current.mergeStatus === 'pending' &&
        current.mergeOperationId === null &&
        current.mergeOperationOwner === null;
      const modernAttempt =
        !!operationId &&
        !!leaseOwner &&
        current.mergeStatus === 'pending' &&
        current.mergeOperationId === operationId &&
        current.mergeOperationOwner === leaseOwner &&
        (!OPEN.includes(current.status) || current.inboxLeaseOwner === leaseOwner);
      if (!legacyAttempt && !modernAttempt) {
        throw new ConflictException('merge operation is no longer current');
      }
      if (released) {
        // Back to the state the click produced: still pending, nobody executing. The
        // request survives the restart and the successor process claims it.
        await tx.session.update({
          where: { id: sessionId },
          data: { mergeOperationOwner: null },
        });
        return;
      }
      await tx.session.update({
        where: { id: sessionId },
        data: {
          mergeStatus: dto.status,
          mergeError: merged ? null : (dto.message ?? null),
          mergedAt: merged ? new Date() : null,
          // A successful merge is authoritative even when ancestry/patch-id heuristics cannot
          // recognize its conflict-adapted replay.
          ...(merged
            ? {
                branchMerged: true,
                mergedSourceSha: dto.sourceSha ?? null,
              }
            : {}),
          // On a successful merge, advance the recorded fork point to the merge tip.
          ...(merged && dto.mergedSha ? { baseSha: dto.mergedSha } : {}),
        },
      });
    });
    // The checkout is free again. A message the user sent while this merge executed is
    // parked PENDING behind the claim fence (see trySessionClaim); re-drive the queue so it
    // gets a slot now instead of on the next ≤5s poll. Not on `released`: the operation is
    // still pending and a successor process re-runs it.
    if (!released) this.queue.notifySessionQueued();
    return { ok: true };
  }

  /** Outcome of a heartbeat-delivered CommitCommand — persist it so the worktree status bar
   *  can flip from Commit to Merge. On success the worktree is clean (worktreeDirty=false),
   *  so the bar shows Merge without waiting for the next live-diff heartbeat; 'nochange' is
   *  also clean. An error keeps the Commit button (commitError carries git's message).
   *  `released` is not an outcome: a runner that drained before touching the repo hands
   *  the claim back. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/commit-result')
  async commitResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SessionCommitResultRequest,
  ) {
    if (
      dto?.status !== 'committed' &&
      dto?.status !== 'nochange' &&
      dto?.status !== 'error' &&
      dto?.status !== 'released'
    ) {
      throw new BadRequestException('invalid commit result status');
    }
    const operationId = parseLeaseGeneration(dto?.operationId, 'operationId');
    const leaseOwner = parseLeaseGeneration(dto?.leaseOwner, 'leaseOwner');
    if (!!operationId !== !!leaseOwner) {
      throw new BadRequestException('operationId and leaseOwner must be provided together');
    }
    const released = dto.status === 'released';
    if (released && !operationId) {
      throw new BadRequestException('released requires the claimed operation');
    }
    const clean = dto.status === 'committed' || dto.status === 'nochange';
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          status: RunStatus;
          inboxLeaseOwner: string | null;
          commitStatus: string | null;
          commitOperationId: string | null;
          commitOperationOwner: string | null;
        }>
      >`
        SELECT status, "inbox_lease_owner" AS "inboxLeaseOwner",
               "commit_status" AS "commitStatus",
               "commit_operation_id" AS "commitOperationId",
               "commit_operation_owner" AS "commitOperationOwner"
        FROM "session"
        WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runner.id}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new ForbiddenException('session does not belong to this runner');
      }
      const current = locked[0];
      const legacyAttempt =
        !operationId &&
        !leaseOwner &&
        current.status === RunStatus.AWAITING_INPUT &&
        current.commitStatus === 'pending' &&
        current.commitOperationId === null &&
        current.commitOperationOwner === null;
      const modernAttempt =
        !!operationId &&
        !!leaseOwner &&
        current.commitStatus === 'pending' &&
        current.commitOperationId === operationId &&
        current.commitOperationOwner === leaseOwner &&
        // The command was admitted while idle. Lifecycle terminalization may win
        // before its receipt POST; accept that exact process/epoch so Resume can
        // safely wait for completion instead of stranding a claimed operation.
        (TERMINAL.includes(current.status) ||
          (current.status === RunStatus.AWAITING_INPUT && current.inboxLeaseOwner === leaseOwner));
      if (!legacyAttempt && !modernAttempt) {
        throw new ConflictException('commit operation is no longer current');
      }
      if (released) {
        // Back to the state the click produced: still pending, nobody executing. The
        // request survives the restart and the successor process claims it.
        await tx.session.update({
          where: { id: sessionId },
          data: { commitOperationOwner: null },
        });
        return;
      }
      await tx.session.update({
        where: { id: sessionId },
        data: {
          commitStatus: dto.status,
          commitError: dto.status === 'error' ? (dto.message ?? null) : null,
          ...(clean ? { worktreeDirty: false } : {}),
        },
      });
    });
    // Mirror mergeResult: release a message queued behind this commit now that the
    // checkout is free, rather than waiting for the queue's periodic poll.
    if (!released) this.queue.notifySessionQueued();
    return { ok: true };
  }

  /** A freshly recomputed live worktree diff, pushed in response to a 'diff' inbox control
   *  turn (the web opened a file whose stored patch lagged). Overwrites the session's
   *  changedFiles and the SessionDiff side-table patches together, so the file list and the
   *  per-file diffs are consistent again. Guarded to OPEN + this runner (mirrors the heartbeat
   *  guard) so a straggler can't clobber a just-finalized session's committed diff. */
  @UseGuards(RunnerAuthGuard)
  @Post('sessions/:id/diff')
  @HttpCode(202)
  async diffResult(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: SessionDiffResultRequest,
  ) {
    await this.assertSessionOwnership(sessionId, runner.id);
    const branchMerged = await this.reconcileReportedBranchMerged(
      sessionId,
      runner.id,
      dto.branchMerged,
      dto.branchSha,
    );
    const updated = await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        assignedRunnerId: runner.id,
        status: { in: OPEN },
      },
      data: {
        ...(dto.changedFiles !== undefined
          ? {
              changedFiles: dto.changedFiles as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(dto.worktreeDirty !== undefined ? { worktreeDirty: dto.worktreeDirty } : {}),
        // Recomputed with the diff, so opening the drawer refreshes "✓ In main" for an idle
        // session merged out-of-band (older runners omit it → left untouched).
        ...(branchMerged !== undefined ? { branchMerged } : {}),
        // The worktree's actual HEAD branch → flags divergence / offers Adopt (older runners omit).
        ...(dto.worktreeBranch !== undefined ? { worktreeBranch: dto.worktreeBranch } : {}),
      },
    });
    // Only persist the patches once we've confirmed the session is still live (count > 0);
    // a no-op update means it finalized, so its committed diff must stay authoritative.
    if (updated.count > 0 && dto.changedDiff !== undefined) {
      await this.prisma.sessionDiff.upsert({
        where: { sessionId },
        create: {
          sessionId,
          patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
        },
        update: {
          patches: dto.changedDiff as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return { ok: true };
  }

  /** Return the runtime session UUID + workDir so `orbit resume` can reattach locally. */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/meta')
  async getSessionMeta(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
  ): Promise<{
    provider: AgentProvider;
    sessionUuid: string;
    runtimeSessionId?: string;
    workDir: string | null;
    title: string;
  }> {
    const session = await this.assertSessionOwnership(sessionId, runner.id);
    const provider = normalizeRuntimeProvider(session.provider, session.providerBuiltin);
    const runtimeSessionId = session.runtimeSessionId ?? undefined;
    if (!runtimeSessionId) {
      throw new NotFoundException('session has no runtime session ID');
    }
    const agent = session.agentId ? await this.prisma.agent.findUnique({ where: { id: session.agentId } }) : null;
    return {
      provider,
      sessionUuid: runtimeSessionId,
      runtimeSessionId,
      workDir: agent?.workDir ?? null,
      title: session.title,
    };
  }

  /**
   * The session's stored transcript, oldest-first, so a runner can rebuild the runtime's own
   * local conversation file when it is gone — a machine that never ran this session, a wiped
   * ~/.claude, a moved cwd (see transcript_rebuild.go). Without it `claude --resume` just says
   * "No conversation found with session ID".
   *
   * Payloads come back WHOLE: unlike the clients' `/events/page`, a rebuilt transcript assembled
   * from preview-truncated tool output would silently rewrite the agent's own history. Paged on
   * `after` so a long session streams in bounded chunks.
   */
  @UseGuards(RunnerAuthGuard)
  @Get('sessions/:id/events')
  async sessionEvents(
    @CurrentRunner() runner: { id: string },
    @Param('id', PublicIdPipe) sessionId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{
    events: { seq: number; type: string; payload: unknown; ts: Date }[];
    hasMore: boolean;
  }> {
    await this.assertSessionOwnership(sessionId, runner.id);
    const asInt = (s: string | undefined, fallback: number): number => {
      const n = Number(s);
      return s !== undefined && s !== '' && Number.isFinite(n) ? Math.trunc(n) : fallback;
    };
    const take = Math.min(Math.max(asInt(limit, 500), 1), 1000);
    const afterSeq = asInt(after, 0);
    const rows = await this.prisma.$queryRaw<
      { seq: number; type: string; payload: unknown; ts: Date }[]
    >`
      SELECT seq, type, payload, created_at AS "ts"
      FROM run_event
      WHERE session_id = ${sessionId}::uuid
        AND seq > ${afterSeq}
        AND ${notNoiseSql}
      ORDER BY seq ASC
      LIMIT ${take + 1}
    `; // one extra row: its presence means newer events remain
    const hasMore = rows.length > take;
    return { events: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  /**
   * Serialize runner-originated writes on the Session row and fence them to the process
   * identity installed by takeover. `IS NOT DISTINCT FROM` deliberately lets legacy
   * runners that omit leaseOwner write only while the Session owner is still NULL.
   */
  private async lockSessionLeaseOwner(
    tx: Prisma.TransactionClient,
    sessionId: string,
    runnerId: string,
    leaseOwner: string | null,
  ): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string; leaseOwnerMatches: boolean }>>`
      SELECT id,
             ("inbox_lease_owner" IS NOT DISTINCT FROM ${leaseOwner}::uuid) AS "leaseOwnerMatches"
      FROM "session"
      WHERE id = ${sessionId}::uuid AND "assigned_runner_id" = ${runnerId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new ForbiddenException('session does not belong to this runner');
    }
    if (!locked[0].leaseOwnerMatches) {
      throw new ConflictException('runner process no longer owns this session');
    }
  }

  /**
   * What this reply does to the session's armed retry — the fields to write, or `{}` to leave
   * both where they are. `text` is the turn's latest assistant message, which for both
   * self-healing failures is the entire reply.
   *
   * Three outcomes:
   *  - an exhausted quota → arm for the moment it resets (below), leaving the attempt count
   *    alone: the sweeper counts against it while the snapshot keeps reporting the quota spent.
   *  - a transient provider error → arm for one backoff step out, or hand back once the steps
   *    are spent. Task-bound sessions are excluded: such a turn also fails their task, which
   *    has its own retry budget (tasks.service AUTO_RUN_RETRY_BACKOFF_MS), and two schedulers
   *    reviving one task is how you get two runs of it.
   *  - anything else, including an error a re-send would reproduce → the run of failures is
   *    over, so clear the count. This is the ONLY thing that clears it: doing it when a retry
   *    is dispatched instead would restart the backoff at every attempt, and a provider that
   *    fails identically every time would be re-sent to forever.
   */
  private async retryPlanFor(
    tx: Prisma.TransactionClient,
    sessionId: string,
    runnerId: string,
    text: string,
  ): Promise<{ retryAt?: Date | null; retryAttempts?: number }> {
    const quotaSpent = isUsageLimitErrorText(text);
    if (!quotaSpent && !isRetryableApiErrorText(text)) return { retryAt: null, retryAttempts: 0 };
    const now = new Date();
    const [session, runner] = await Promise.all([
      tx.session.findUnique({
        where: { id: sessionId },
        select: { provider: true, taskId: true, retryAttempts: true },
      }),
      quotaSpent
        ? tx.runner.findUnique({ where: { id: runnerId }, select: { planUsage: true } })
        : null,
    ]);
    if (!session) return {};
    if (!quotaSpent) {
      if (session.taskId) return {};
      return { retryAt: apiErrorRetryAt(session.retryAttempts, now) };
    }
    // When the quota comes back, from two sources in this order. The runtime's own sentence is
    // available on the spot but is prose ("resets 6:20pm (Europe/Berlin)") and Codex's phrasing
    // pins no time zone at all; the runner's quota snapshot is machine-readable but refreshes on
    // its own cadence, so it can still be describing the pre-limit world at this instant. Text
    // first for immediacy, snapshot as the fallback — and the sweeper re-checks the snapshot
    // before it fires, so a wrong-but-early guess costs a deferral, never a wasted turn.
    //
    // The jitter is not cosmetic: a quota is an *account*-wide fact, so every session that hit
    // it comes due at the same instant, and releasing them together would reproduce the outage
    // against the freshly reset window.
    const at =
      parseQuotaResetAt(text, now) ??
      planUsageBlockedUntil(runner?.planUsage as PlanUsage | null, session.provider, now);
    // No defensible moment → leave any earlier arming standing rather than replacing it with
    // nothing; the card falls back to a manual retry.
    if (!at) return {};
    return { retryAt: new Date(at.getTime() + Math.floor(Math.random() * QUOTA_RETRY_JITTER_MS)) };
  }

  private async assertSessionOwnership(sessionId: string, runnerId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.assignedRunnerId !== runnerId) {
      throw new ForbiddenException('session does not belong to this runner');
    }
    return session;
  }

  /** Reconcile the runner's heuristic merged verdict with the exact source tip captured by a
   * successful Orbit merge. `branchMerged=false` is deliberately conservative: ancestry and
   * patch-id both fail when a rebase adapts overlapping target changes. If the reported branch
   * SHA still equals mergedSourceSha, keep the successful merge authoritative and normalize the
   * snapshot to true. A missing reported SHA is inconclusive and preserves a stored exact marker;
   * only two present, different SHAs prove new commits landed. Legacy merge results without an
   * exact marker retain the historical false-clears behavior.
   */
  private async reconcileReportedBranchMerged(
    sessionId: string,
    runnerId: string,
    reported?: boolean,
    branchSha?: string,
    leaseOwner?: string,
  ): Promise<boolean | undefined> {
    if (reported !== false) return reported;
    const merged = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        assignedRunnerId: runnerId,
        status: { in: OPEN },
        mergeStatus: 'merged',
        ...(leaseOwner !== undefined ? { inboxLeaseOwner: leaseOwner } : {}),
      },
      select: {
        mergedSourceSha: true,
        mergeOperationId: true,
        mergeOperationOwner: true,
      },
    });
    if (!merged) return false;
    if (merged.mergedSourceSha && (!branchSha || merged.mergedSourceSha === branchSha)) {
      return true;
    }

    await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        assignedRunnerId: runnerId,
        status: { in: OPEN },
        mergeStatus: 'merged',
        // Fence a racing fresh merge-result: the source tip may be identical
        // across attempts, so bind the cleanup to the exact operation receipt too.
        mergedSourceSha: merged.mergedSourceSha,
        mergeOperationId: merged.mergeOperationId,
        mergeOperationOwner: merged.mergeOperationOwner,
        ...(leaseOwner !== undefined ? { inboxLeaseOwner: leaseOwner } : {}),
      },
      data: {
        mergeStatus: null,
        mergeOperationId: null,
        mergeOperationOwner: null,
        mergeError: null,
        mergedSourceSha: null,
      },
    });
    return false;
  }
}
