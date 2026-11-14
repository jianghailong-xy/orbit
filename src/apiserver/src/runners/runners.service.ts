import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  ClaudeRegionCheckRequest,
  DirProbeAnswer,
  RunnerResourcesAnswer,
  InstallEngine,
  LoginEngine,
  ReportedEngine,
  RunnerAccountRemoveState,
  RunnerEngineAccount,
  RunnerInstallState,
  RunnerLoginState,
  SlashCommandInfo,
  RunnerUpdateTurn,
} from '@orbit/shared';
import { CLAUDE_REGION_UNSUPPORTED, CLAUDE_REGION_V1, LOGIN_FAILURE_REASONS, SELF_UPDATE_NOW_V1, SELF_UPDATE_POSTPONE_V1 } from '@orbit/shared';
import type {
  RunnerSelfUpdateNowRequest,
  RunnerSelfUpdateNowResponse,
  RunnerSelfUpdatePostponeRequest,
  RunnerSelfUpdatePostponeResponse,
} from '@orbit/shared';
import { RunStatus } from '@prisma/client';
import { generateToken, sha256 } from '../common/crypto.util';
import { agentFixesOf } from './attention-fix';
import { namedRunnerEngines, sanitizeEngineUpdateDismissals, sanitizeRunnerEngines, usedPlanUsage, usedRunnerEngines } from '../common/runner-engines';
import {
  antigravityGoogleLoginRefusal,
  antigravitySignInUnderWay,
  antigravityState,
} from '../common/antigravity-readiness';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { sanitizeRunnerSelfUpdate } from '../common/runner-self-update';
import { drainWaitingOf } from '../common/runner-drain-waiting';
import { postponeUntil } from './self-update-postpone';
import { ACTIVE_TURN_STATUSES } from '../common/session-scheduling';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CLAUDE_ACCOUNT_REMOVE_V1,
  ANTIGRAVITY_ACCOUNT_REMOVE_V1,
  CODEX_ACCOUNT_REMOVE_V1,
  CURSOR_ACCOUNT_LOGIN_V1,
  CURSOR_ACCOUNT_REMOVE_V1,
  CURSOR_LOGIN_TOO_OLD,
  KIMI_ACCOUNT_REMOVE_V1,
  LOGIN_RELAY_TIMEOUT_MS,
  accountLoginTooOld,
} from '../runner-api/runner-api.controller';
import { CURSOR_RUNNER_UPGRADE_ERROR, runnerKnowsCursor } from '../runner-api/runner-provider-support';
import { loginCodeRelay } from './login-code-relay';
import { engineKeepsAccounts } from '../common/runner-engines';
import { ENGINE_LABELS } from '../sessions/engine-signin-preflight';
import { ACCOUNT_ID_PATTERN, CreateEnrollmentTokenDto, StartLoginDto, UpdateRunnerDto } from './dto';
import { accountPauseUntil } from '../common/account-pause';
import { refuseManagedRunnerDeletion, refuseManagedRunnerRotation } from '../managed-runners/managed-runner-delete';
import { RUNNER_BEATS, runnerIsOnline, runnerLastBeatAt } from './runner-presence';
import { runnerResourcesAnswerOf } from './runner-resources';
import { DIR_PROBE_MAX_PATH, dirProbeAnswerOf } from './dir-probe';
import { isInternalAddress } from '../shared/public-surface.guard';
import { blockedRunnerRegion, claudeRegionSignInRefusal, regionMachineName, runnerRegionView } from './runner-region';
import { activeSessionsOn, engineHealthWithActiveSessions } from '../providers/active-sessions';

/** The statuses an abandoned checkout can belong to: a session that has stopped running for good.
 *  A parked one can be dirty between turns and is not abandoned, so it is not listed. */
const FINISHED_SESSION_STATUSES = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

// Cap device-enrollment userCode lookups per user, so an authenticated insider
// cannot brute-force another user's pending enrollment code online.
const DEVICE_LOOKUP_WINDOW_MS = 5 * 60_000;
const DEVICE_LOOKUP_MAX = 20;
/** The phases whose Update card offers Update Now…, whose confirm names the turns it interrupts. */
const UPDATE_TURNS_PHASES = new Set<string>(['available', 'draining', 'postponed']);

/** The activity row a Later writes (RunnersService.postponeSelfUpdate): who put which runner's update off, until when. */
export const RUNNER_SELF_UPDATE_POSTPONED_ACTIVITY = 'runner.self_update.postponed';
/** The activity row an Update Now writes (RunnersService.updateSelfNow): who had which runner interrupt which turns. */
export const RUNNER_SELF_UPDATE_NOW_ACTIVITY = 'runner.self_update.now';

@Injectable()
export class RunnersService {
  private readonly logger = new Logger(RunnersService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional, and last, for the specs that build this service on a bare Prisma: without it a
    // sign-in still reaches the runner, on its next heartbeat instead of at once.
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  private readonly deviceLookups = new Map<string, number[]>();

  /** Throttle per-user userCode lookups to defeat online enumeration. */
  private rateLimitDeviceLookup(userId: string): void {
    const now = Date.now();
    const recent = (this.deviceLookups.get(userId) ?? []).filter(
      (t) => now - t < DEVICE_LOOKUP_WINDOW_MS,
    );
    if (recent.length >= DEVICE_LOOKUP_MAX) {
      throw new HttpException(
        'too many enrollment lookups, slow down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.deviceLookups.set(userId, recent);
  }

  async listRunners(ownerId: string) {
    return this.runnerViews({ ownerId });
  }

  /** One of this owner's runners, in exactly the shape the list gives each of them. */
  async getRunner(ownerId: string, id: string) {
    const [runner] = await this.runnerViews({ ownerId, id });
    if (!runner) throw new NotFoundException('runner not found');
    return runner;
  }

  private async runnerViews(where: { ownerId: string; id?: string }) {
    const runners = await this.prisma.runner.findMany({
      where,
      orderBy: [
        { position: { sort: 'asc', nulls: 'last' } },
        { enrolledAt: 'asc' },
        { id: 'asc' },
      ],
      select: {
        id: true,
        name: true,
        displayName: true,
        hostname: true,
        labels: true,
        status: true,
        maxConcurrent: true,
        version: true,
        // When it was last heard from (runners/runner-presence.ts), shown as `lastHeartbeatAt`.
        ...RUNNER_BEATS,
        enrolledAt: true,
        position: true,
        availableCommands: true,
        availableSkills: true,
        // Latest provider plan-usage snapshot; passed straight through to the UI (it
        // rides `...r` below, unlike commands/skills which get renamed).
        planUsage: true,
        // Runtime model catalog reported by the runner (Codex model picker source).
        modelCatalog: true,
        // Runtime defaults reported by the runner heartbeat. This is capability state, not a
        // user-editable Runner setting.
        runtimeDefaultModels: true,
        // Same: reported, not configured. Withdraws Bypass from this machine's Mode pickers, which
        // is the only reason clients need to know (see ROOT_REFUSED_PERMISSION_MODES).
        runsAsRoot: true,
        // Reported too: why this runner is or isn't updating itself, for its card on Infrastructure
        // and its Update Runner Now. Re-sanitized below, null for a runner that does not report it.
        selfUpdate: true,
        // The runner page's Capacity › Keep Free reads the floor it writes (PATCH minFreeDiskMb),
        // and About › Repos Folder shows where this machine clones to (reported, not configured).
        minFreeDiskMb: true,
        reposRoot: true,
        // Where `orbit register` ran: the folder a machine's first workspace is offered, once the
        // directory probe has found it there (docs/first-workspace-contract.md §1).
        registerDir: true,
        // What Codex rate-limit reset admission reads about this machine
        // (docs/codex-rate-limit-reset-contract.md §4, §6.1). The web disables its reset entry on
        // the same codexResetRefusal answer the create route refuses with, so it needs the same
        // inputs: the declared capabilities and the last heartbeat's lease owner and draining flag.
        capabilities: true,
        heartbeatLeaseOwner: true,
        heartbeatDraining: true,
        // Per-engine health, and any install the user started for one of them — both drive the
        // engine rows under each machine on Infrastructure. The accounts carry the names given
        // them here, not only the ones the runner reports, and leave out a Default removed from
        // Orbit (usedRunnerEngines).
        engines: true,
        accountNames: true,
        accountPauses: true,
        defaultRemoved: true,
        // The engine update warnings dismissed here, each until the next release (migration 0705).
        engineUpdateDismissals: true,
        // The sessions Fix with an agent started here, one per warning (migration 0760).
        attentionFixes: true,
        installStatus: true,
        installEngine: true,
        installCommand: true,
        installMessage: true,
        installMode: true,
        // The account-removal relay Infrastructure reads its outcome from: which engine's
        // store, which slot is going, and — when the machine refused — what it said.
        accountRemoveEngine: true,
        codexAccountRemoveAccount: true,
        codexAccountRemoveStatus: true,
        codexAccountRemoveMessage: true,
        // Where this machine's Claude connection to Anthropic comes out (docs/claude-region-check-contract.md §6), read
        // with the capabilities above: only a runner that declares claude-region/v1 has a region to show.
        region: true,
      },
    });
    // How many slots each runner is currently using, so the list can show
    // utilization (e.g. "3 / 16 running") rather than capacity alone.
    const liveCounts = await this.prisma.session.groupBy({
      by: ['assignedRunnerId'],
      where: {
        assignedRunnerId: { in: runners.map((r) => r.id) },
        status: { in: ACTIVE_TURN_STATUSES },
      },
      _count: { _all: true },
    });
    const activeByRunner = new Map(
      liveCounts.map((c) => [c.assignedRunnerId, c._count._all]),
    );
    // A runner heartbeats every 30s; treat a missed window as offline so the UI
    // reflects dropouts without waiting for a background reaper.
    const now = Date.now();
    // Each runner's engines as Orbit uses them (usedRunnerEngines): named, paused, and without a
    // Default removed from Orbit. null (not []) for a runner that has never reported: "we don't know
    // yet" and "nothing is installed" are different answers, and only one of them is ours to make up.
    // Each account says how many sessions are at work on it, so that a client's "starts on" is the server's.
    const atWork = await activeSessionsOn(this.prisma, runners, new Date(now));
    const used = runners.map((runner) => engineHealthWithActiveSessions(usedRunnerEngines(runner), atWork.get(runner.id)));
    const updateTurns = await this.updateTurnsOf(where.ownerId, runners);
    const drainWaiting = await drainWaitingOf(this.prisma, where.ownerId, runners);
    // Fix with an agent: where a press would start its session on each runner, or why it can't, and the
    // agents already at work there (attention-fix.ts, the same answer the fix endpoint acts on).
    const agentFixes = await agentFixesOf(this.prisma, where.ownerId, runners, now);
    return runners.map(({
      availableCommands,
      availableSkills,
      runtimeDefaultModels,
      engines,
      accountNames,
      accountPauses,
      defaultRemoved,
      engineUpdateDismissals,
      attentionFixes,
      installStatus,
      installEngine,
      installCommand,
      installMessage,
      installMode,
      accountRemoveEngine,
      codexAccountRemoveAccount,
      codexAccountRemoveStatus,
      codexAccountRemoveMessage,
      selfUpdate,
      presence,
      region,
      ...r
    }, index) => ({
      ...r,
      // Its last beat, from either record of it: what every client reads "last seen" from.
      lastHeartbeatAt: runnerLastBeatAt({ lastHeartbeatAt: r.lastHeartbeatAt, presence }),
      // Without the part of a removed Default, as the engines are.
      planUsage: usedPlanUsage(r.planUsage, used[index]),
      // Never expose null or malformed JSON: clients can always index this as a provider map.
      runtimeDefaultModels: sanitizeRuntimeDefaultModels(runtimeDefaultModels),
      selfUpdate: sanitizeRunnerSelfUpdate(selfUpdate),
      // The effective verdict, never the stored one; null without the capability or a decided check.
      region: runnerRegionView({ region, capabilities: r.capabilities }, new Date(now)),
      engines: used[index],
      // { engine: latest } — each engine's update warning stays hidden while this equals its update.latest.
      engineUpdateDismissals: sanitizeEngineUpdateDismissals(engineUpdateDismissals),
      agentFix: agentFixes.get(r.id) ?? null,
      antigravity: antigravityState({ capabilities: r.capabilities, engines: used[index] }),
      install: installStateOf({
        installStatus,
        installEngine,
        installCommand,
        installMessage,
        installMode,
      }),
      accountRemove: accountRemoveStateOf({
        accountRemoveEngine,
        codexAccountRemoveAccount,
        codexAccountRemoveStatus,
        codexAccountRemoveMessage,
      }),
      online: runnerIsOnline({ status: r.status, lastHeartbeatAt: r.lastHeartbeatAt, presence }, now),
      activeSessions: activeByRunner.get(r.id) ?? 0,
      // Only on a runner draining for its self-update: the viewer's turns the drain waits for.
      ...(updateTurns.has(r.id) ? { updateTurns: updateTurns.get(r.id) } : {}),
      // Only while it drains and something of the viewer's waits on it: the banner and attention item (D3).
      ...(drainWaiting.has(r.id) ? { drainWaiting: drainWaiting.get(r.id) } : {}),
      // Surface the `/` autocomplete catalog under clean names (mirrors the heartbeat DTO).
      commands: (availableCommands ?? []) as unknown as SlashCommandInfo[],
      skills: (availableSkills ?? []) as unknown as SlashCommandInfo[],
    }));
  }

  /**
   * The turns each draining runner's Update card names (docs/runner-update-drain-design.md §3.5,
   * board 4), and the turns Update Now's confirm says it interrupts (board 3 ⑧): the viewer's RUNNING
   * sessions on it, longest-running first, with when the current run was claimed. Only runners whose
   * heartbeat says draining, or whose report has a release waiting (available, draining, postponed),
   * are asked about, so a runner that is not updating costs nothing. Another owner's turns are not named here, as in
   * queuedRunnerUpdate; the card's count (turnsInFlight) still covers them.
   */
  private async updateTurnsOf(
    ownerId: string,
    runners: Array<{ id: string; selfUpdate: unknown; heartbeatDraining: boolean | null }>,
  ): Promise<Map<string, RunnerUpdateTurn[]>> {
    const draining = runners
      .filter((r) => r.heartbeatDraining === true || UPDATE_TURNS_PHASES.has(sanitizeRunnerSelfUpdate(r.selfUpdate)?.phase ?? ''))
      .map((r) => r.id);
    const turns = new Map<string, RunnerUpdateTurn[]>(draining.map((id) => [id, []]));
    if (draining.length === 0) return turns;
    const rows = await this.prisma.session.findMany({
      where: { assignedRunnerId: { in: draining }, ownerId, status: RunStatus.RUNNING, deletedAt: null },
      select: { id: true, title: true, assignedRunnerId: true, runClaimedAt: true, lastTurnAt: true },
      orderBy: [{ runClaimedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
    for (const row of rows) {
      const startedAt = row.runClaimedAt ?? row.lastTurnAt;
      turns.get(row.assignedRunnerId!)?.push({
        id: row.id,
        title: row.title || null,
        startedAt: startedAt ? startedAt.toISOString() : null,
      });
    }
    return turns;
  }

  /**
   * Persist one owner's runner order. Invalid, foreign, duplicate, and stale ids
   * are ignored; owned runners omitted by a stale client retain their current
   * relative order at the end of the submitted list.
   */
  async reorderRunners(ownerId: string, ids: string[]) {
    const current = await this.prisma.runner.findMany({
      where: { ownerId },
      orderBy: [
        { position: { sort: 'asc', nulls: 'last' } },
        { enrolledAt: 'asc' },
        { id: 'asc' },
      ],
      select: { id: true },
    });
    const ownedIds = new Set(current.map((runner) => runner.id));
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of ids) {
      if (!ownedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
    for (const { id } of current) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }

    const ranked = ordered
      .map((id, position) => ({ id, position }))
      // Every concurrent reorder locks the same runner rows in the same order,
      // preventing opposite drag requests from deadlocking one another.
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    if (ranked.length === 0) return this.listRunners(ownerId);
    // Retried whole, for the residual conflict the id ordering above cannot rule out: a heartbeat
    // writes these same rows. Safe to re-run because `ranked` is computed once, outside the
    // closure, so every attempt writes exactly the same positions to exactly the same rows.
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        for (const { id, position } of ranked) {
          await tx.runner.update({ where: { id }, data: { position } });
        }
      },
      loggedRetry(this.logger, 'runners.reorder'),
    );
    return this.listRunners(ownerId);
  }

  async createEnrollmentToken(ownerId: string, dto: CreateEnrollmentTokenDto) {
    const raw = generateToken(24);
    const expiresAt = dto.ttlHours
      ? new Date(Date.now() + dto.ttlHours * 3600 * 1000)
      : null;
    const rec = await this.prisma.enrollmentToken.create({
      data: { ownerId, tokenHash: sha256(raw), label: dto.label, expiresAt },
    });
    // The raw token is shown exactly once — only its hash is persisted.
    return { id: rec.id, token: raw, label: rec.label, expiresAt: rec.expiresAt };
  }

  listEnrollmentTokens(ownerId: string) {
    return this.prisma.enrollmentToken.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, label: true, expiresAt: true, usedAt: true, createdAt: true },
    });
  }

  /**
   * Details shown on the browser approval page for an `orbit register` session, read from
   * `readerIp` (visitorAddress of the page's own request).
   */
  async getDeviceEnrollment(ownerId: string, userCode: string, readerIp: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.openDeviceEnrollment(ownerId, userCode);
    // Warn (don't block) if a runner with this name is already registered, so the
    // user knows approving re-issues its credential rather than adding a 2nd machine —
    // and when that runner was last heard from, so they can tell whether it is this one.
    const existing = await this.prisma.runner.findFirst({
      where: { ownerId, name: s.name, managedRunner: { is: null } },
      orderBy: { enrolledAt: 'desc' },
      select: { lastHeartbeatAt: true },
    });
    return {
      userCode: s.userCode,
      name: s.name,
      hostname: s.hostname,
      labels: s.labels,
      maxConcurrent: s.maxConcurrent,
      status: s.status,
      // Where `orbit register` ran, and whether this page is read from the same address. A link
      // someone else started and sent here shows a code that always matches; this is what tells.
      // Never for an internal address: behind a proxy TRUSTED_PROXIES does not name, every
      // request comes from the proxy's, a stranger's included.
      requesterIp: s.requesterIp,
      sameNetwork: !!s.requesterIp && s.requesterIp === readerIp && !isInternalAddress(s.requesterIp),
      nameConflict: !!existing,
      existingLastSeenAt: existing?.lastHeartbeatAt ?? null,
      // The runner an approval minted, for the page's way to it.
      runnerId: s.status === 'APPROVED' ? s.runnerId : null,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    };
  }

  /**
   * Approve a device session: mint one Runner for the machine, then stash its
   * credential. Workspaces are registered separately, not here. The session is
   * claimed first, so an approval and a denial racing each other settle on one.
   *
   * Nothing here says the machine is there: only its own heartbeat does. A new runner is OFFLINE and
   * never heard from until then, and a re-registered one keeps what its last beat left, which reads
   * as it did a moment ago and ages out if no process comes back with the new credential.
   */
  async approveDeviceEnrollment(ownerId: string, userCode: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.openDeviceEnrollment(ownerId, userCode);
    const runnerName = s.name;
    if (s.status !== 'PENDING') return deviceDecidedAlready(s, 'APPROVED');
    const claimed = await this.prisma.deviceEnrollment.updateMany({
      where: { id: s.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: 'APPROVED', approvedById: ownerId, approvedAt: new Date() },
    });
    if (claimed.count !== 1) {
      return deviceDecidedAlready(await this.openDeviceEnrollment(ownerId, userCode), 'APPROVED');
    }

    // One Runner per machine. Re-registering reuses the same runner (reissuing its
    // credential) rather than duplicating, so the machine keeps its identity and
    // run history.
    const runnerToken = generateToken(32);
    // The directory `orbit register` ran in: what this registration says, when it says one
    // (docs/first-workspace-contract.md §1).
    const registerDir = s.workDir?.trim();
    const data = {
      hostname: s.hostname,
      labels: s.labels,
      maxConcurrent: s.maxConcurrent,
      version: s.version,
      tokenHash: sha256(runnerToken),
      ...(registerDir ? { registerDir } : {}),
    };
    // Never a managed runner: its identity and credential belong to its mapping, not to a name.
    const existing = await this.prisma.runner.findFirst({
      where: { ownerId, name: runnerName, managedRunner: { is: null } },
      orderBy: { enrolledAt: 'desc' },
    });
    const runner = existing
      ? await this.prisma.runner.update({ where: { id: existing.id }, data })
      : await this.prisma.runner.create({ data: { ...data, name: runnerName, ownerId } });

    await this.prisma.deviceEnrollment.update({
      where: { id: s.id },
      data: { runnerId: runner.id, runnerToken },
    });
    return { ok: true, name: runnerName, replaced: !!existing, runnerId: runner.id };
  }

  /**
   * Deny a device session: its CLI is told so on its next poll and stops, and nothing is minted.
   * Denying one already denied is answered as it stands, as approving is.
   */
  async denyDeviceEnrollment(ownerId: string, userCode: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.openDeviceEnrollment(ownerId, userCode);
    if (s.status !== 'PENDING') return deviceDecidedAlready(s, 'DENIED');
    const now = new Date();
    const denied = await this.prisma.deviceEnrollment.updateMany({
      where: { id: s.id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'DENIED', approvedById: ownerId, approvedAt: now },
    });
    if (denied.count === 1) return { ok: true, name: s.name };
    return deviceDecidedAlready(await this.openDeviceEnrollment(ownerId, userCode), 'DENIED');
  }

  /** A device session `ownerId` may see and decide, or 404 — gone, past its ten minutes, or decided by another account. */
  private async openDeviceEnrollment(ownerId: string, userCode: string) {
    const s = await this.prisma.deviceEnrollment.findUnique({ where: { userCode } });
    if (!s || s.expiresAt < new Date() || decidedByAnother(s, ownerId)) {
      throw new NotFoundException('enrollment request not found or expired');
    }
    return s;
  }

  async updateRunner(ownerId: string, id: string, dto: UpdateRunnerDto) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const data: {
      displayName?: string | null;
      maxConcurrent?: number;
      minFreeDiskMb?: number | null;
    } = {};
    if (dto.displayName !== undefined) {
      const trimmed = dto.displayName.trim();
      data.displayName = trimmed.length ? trimmed : null;
    }
    // The queue gates live sessions on this per claim, so a change takes effect
    // next cycle without restarting the runner.
    if (dto.maxConcurrent !== undefined) {
      data.maxConcurrent = dto.maxConcurrent;
    }
    // Read by the auto-run sweep against each workspace's own measured filesystem; null clears
    // the floor. Also effective next sweep — nothing to restart.
    if (dto.minFreeDiskMb !== undefined) {
      data.minFreeDiskMb = dto.minFreeDiskMb;
    }
    // Never echo back tokenHash.
    return this.prisma.runner.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        displayName: true,
        maxConcurrent: true,
        minFreeDiskMb: true,
      },
    });
  }

  /**
   * The checkouts of this machine's finished sessions that still hold work no branch has, as the
   * runner's last scan reported them (RunnerApiController.abandonedCheckouts). This is the list
   * the runner page shows, with Commit and Discard beside each one; a row whose session has
   * since been resumed or deleted is not an abandoned checkout any more and is left out.
   *
   * `patches` is deliberately not read here: the diff text lives in the row, can be hundreds of
   * KB, and is fetched one checkout at a time ({@link abandonedCheckoutDiff}) when somebody opens
   * it. `hasPatches` says whether there is anything to open.
   */
  async abandonedCheckouts(ownerId: string, id: string) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!runner) throw new NotFoundException('runner not found');
    const rows = await this.prisma.abandonedCheckout.findMany({
      where: { runnerId: id, ownerId, session: { status: { in: FINISHED_SESSION_STATUSES } } },
      orderBy: { observedAt: 'asc' },
      select: {
        sessionId: true,
        files: true,
        hasPatches: true,
        observedAt: true,
        session: {
          select: {
            title: true,
            branch: true,
            status: true,
            commitStatus: true,
            commitError: true,
            commitResultMessage: true,
          },
        },
      },
    });
    return {
      checkouts: rows.map((row) => ({
        sessionId: row.sessionId,
        title: row.session.title,
        branch: row.session.branch,
        status: row.session.status,
        files: row.files,
        hasPatches: row.hasPatches,
        observedAt: row.observedAt,
        commitStatus: row.session.commitStatus,
        commitError: row.session.commitError,
        commitResultMessage: row.session.commitResultMessage,
      })),
    };
  }

  /** One abandoned checkout's per-file diffs, for the drawer that shows them.
   *
   *  Both the runner and the session are resolved for this owner first, so another account's
   *  session is answered as one that names nothing — and a session of the caller's that has no
   *  entry (committed, discarded, or reclaimed since the list was read) answers with no patches
   *  rather than an error: there is simply nothing left to show. */
  async abandonedCheckoutDiff(ownerId: string, id: string, sessionId: string) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!runner) throw new NotFoundException('runner not found');
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const row = await this.prisma.abandonedCheckout.findFirst({
      where: { sessionId, runnerId: id, ownerId },
      select: { sessionId: true, files: true, patches: true },
    });
    return { sessionId, files: row?.files ?? [], patches: row?.patches ?? [] };
  }

  /**
   * Reissue a runner's long-lived credential. The old token stops authenticating
   * immediately (only the new hash is kept), so the runner will 401 until its
   * config.json runnerToken is updated and it is restarted. The raw token is
   * returned exactly once — same one-shot contract as enrollment.
   */
  /**
   * Ask this runner to start a browser-less sign-in for one engine. The next heartbeat picks it
   * up; the runner reports back what the user has to do (a URL to approve, plus a one-time code
   * for codex's device flow), then whether it ended up signed in.
   *
   * Starting over is always allowed: the runner's relay kills a previous CLI when it starts a
   * new one for the same account, and a user staring at a stuck card needs a way out that isn't
   * waiting ten minutes. One relay at a time per runner, so asking for codex while claude's is in
   * flight replaces it; whatever the replaced one still reports names its attempt, and is dropped.
   *
   * Codex may be told which account to sign in: one the runner has (`account`, 'default' or a
   * slot id), or a new one it adds under `accountName`. Naming neither signs in the runner's own
   * login, exactly as before accounts.
   *
   * Antigravity signs in a Google account, which only a runner that relays that sign-in can do: any
   * other is refused here, in words the person who pressed the button can act on, rather than left
   * to fail on the machine.
   *
   * Kimi may be told which of its two sites to sign in on (`region`: kimi.com or kimi.ai, whose
   * accounts are separate). Naming none is the bare `kimi login` it always was, which goes wherever
   * the CLI decides; a runner too old to choose is refused at the heartbeat that would hand it over.
   * Kimi keeps accounts too, so a site can come with an account or a new one's name: the start hands
   * both over, and the new account signs in on that site.
   *
   * Cursor CLI is signed in only on a runner that declares cursor-account-login/v1, Default's account
   * included, and any other is refused here as Antigravity's is: an older runner would sign Claude Code
   * in for an engine it does not know. The heartbeat asks the polling process again.
   */
  async startLogin(ownerId: string, id: string, dto: StartLoginDto = {}): Promise<RunnerLoginState> {
    const engine: LoginEngine = dto.engine ?? 'claude';
    const accountName = dto.accountName?.trim();
    if (dto.account != null && dto.accountName != null) {
      throw new BadRequestException('Sign in an account the runner has or a new one, not both');
    }
    if ((dto.account != null || dto.accountName != null) && !engineKeepsAccounts(engine)) {
      throw new BadRequestException('Only an engine that keeps a login per directory signs in more than one account');
    }
    // A blank name must not read as "no account": that is the runner's own login, and signing a
    // second account in there would replace it.
    if (dto.accountName != null && !accountName) {
      throw new BadRequestException('A new account needs a name');
    }
    if (dto.region != null && engine !== 'kimi') {
      throw new BadRequestException('Only Kimi Code signs in on a site of your choosing');
    }
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only sign in while connected');
    }
    const signsInCursor = !!runner.capabilitiesReportedAt && !!runner.capabilities?.includes(CURSOR_ACCOUNT_LOGIN_V1);
    const namesAccount = dto.accountName != null || (dto.account != null && dto.account !== 'default');
    const refusal = engine === 'antigravity'
      ? antigravityGoogleLoginRefusal(runner)
      : engine === 'cursor' && !signsInCursor
        ? (namesAccount ? accountLoginTooOld('cursor') : CURSOR_LOGIN_TOO_OLD)
        : null;
    if (refusal) throw new BadRequestException(refusal);
    // Claude's sign-in talks to Anthropic, so it is not started on a runner whose Claude connection to Anthropic is in
    // a region Anthropic does not offer Claude in (docs/claude-region-check-contract.md §12): no login request is
    // recorded for its heartbeat to carry, and the refusal is board 04's sentence under the code. The runner refuses
    // `claude auth login` in the same words while its own verdict is blocked. One that does not declare
    // claude-region/v1 is never refused (⑤).
    const regionBlocked = engine === 'claude' ? blockedRunnerRegion(runner, new Date()) : null;
    if (regionBlocked) {
      throw new ConflictException({
        code: CLAUDE_REGION_UNSUPPORTED,
        message: claudeRegionSignInRefusal(regionMachineName(runner), regionBlocked.name),
        runnerId: id,
      });
    }
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        loginStatus: 'pending',
        loginEngine: engine,
        loginAccount: dto.account ?? null,
        loginAccountName: accountName ?? null,
        loginRegion: dto.region ?? null,
        loginUrl: null,
        loginUserCode: null,
        loginCode: null,
        loginMessage: null,
        loginExpiresAt: null,
        loginReason: null,
        loginAt: new Date(),
      },
    });
    // A code still held for the sign-in this replaces belongs to nobody now.
    loginCodeRelay.drop(id);
    // The runner picks the start up on its next heartbeat; have that be now rather than up to half a
    // minute from now, with the person who pressed the button watching a spinner.
    this.realtime?.notifyRunnerWake(id);
    return loginStateOf(r);
  }

  /**
   * Hand the runner the authorization code the user pasted. Stored for the next heartbeat to
   * deliver, then cleared — it is single-use, and useless without the PKCE verifier that never
   * leaves the runner process.
   *
   * Only the paste-back flow ever reaches here: codex's device flow sits in `awaiting_approval`,
   * where the code goes to the browser, not through us.
   *
   * Antigravity's code is not stored at all: it is held in this process's memory for the sign-in it
   * was pasted for, until the next heartbeat hands it over (login-code-relay.ts).
   */
  async submitLoginCode(ownerId: string, id: string, code: string): Promise<RunnerLoginState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.loginStatus !== 'awaiting_code') {
      throw new BadRequestException('This runner is not waiting for a sign-in code');
    }
    const trimmed = code?.trim();
    if (!trimmed) throw new BadRequestException('Code is empty');
    const inMemory = runner.loginEngine === 'antigravity';
    const r = await this.prisma.runner.update({
      where: { id },
      data: inMemory ? { loginMessage: null } : { loginCode: trimmed, loginMessage: null },
    });
    if (inMemory && runner.loginAt) {
      loginCodeRelay.hold(id, runner.loginAt.toISOString(), trimmed, runner.loginAt.getTime() + LOGIN_RELAY_TIMEOUT_MS);
    }
    this.realtime?.notifyRunnerWake(id);
    return loginStateOf(r);
  }

  /** Current relay state for the card to poll. */
  async getLoginState(ownerId: string, id: string): Promise<RunnerLoginState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    return loginStateOf(runner);
  }

  /**
   * Abandon an in-flight relay so the card can be dismissed without waiting for the timeout.
   *
   * An Antigravity sign-in is stopped on the machine as well: a runner signing a new Google account
   * in sets the one it had aside, and puts it back only when that attempt ends — left to its timeout,
   * the machine would read as signed out for ten minutes. So the row keeps that attempt as
   * `cancelling` until the next heartbeat hands the runner a `cancel` for it (drainLoginRequest).
   * Every reader sees nothing in flight from here on (loginStateOf).
   */
  async cancelLogin(ownerId: string, id: string): Promise<RunnerLoginState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const stopOnRunner = antigravitySignInUnderWay(runner);
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        loginStatus: stopOnRunner ? 'cancelling' : null,
        loginEngine: stopOnRunner ? runner.loginEngine : null,
        loginAccount: null,
        loginAccountName: null,
        loginRegion: null,
        loginUrl: null,
        loginUserCode: null,
        loginCode: null,
        loginMessage: null,
        loginExpiresAt: null,
        loginReason: null,
        loginAt: stopOnRunner ? runner.loginAt : null,
      },
    });
    loginCodeRelay.drop(id);
    if (stopOnRunner) this.realtime?.notifyRunnerWake(id);
    return loginStateOf(r);
  }

  /**
   * Ask this runner to remove one account slot of `engine`: the slot's own directory with everything
   * the CLI keeps in it — a CODEX_HOME, a CLAUDE_CONFIG_DIR — and the record beside it. The runner
   * is woken to heartbeat at once, picks it up there and reports what happened.
   *
   * `default` never reaches the runner: it is the directory the machine's own environment selects,
   * and the one the CLI typed in a terminal shares, so there is nothing to remove there without taking
   * the user's own login with it. It is removed from Orbit instead (removeDefault).
   *
   * A runner that has not declared that engine's account-removal capability is refused in words the
   * person who pressed the button can act on — the alternative is a request that sits pending until
   * the relay's timeout and then fails with nothing useful in it.
   *
   * Removing an account the runner no longer reports is allowed and ends the same way: the runner
   * finds nothing left to remove and reports done. A workspace that had selected the slot keeps
   * pointing at it and reads as "not on this runner" — nothing here rewrites one.
   */
  async removeAccount(
    ownerId: string,
    id: string,
    engine: LoginEngine,
    account: string,
  ): Promise<RunnerAccountRemoveState> {
    if (!engineKeepsAccounts(engine)) {
      throw new BadRequestException(`Only an engine that keeps accounts can remove one`);
    }
    if (!ACCOUNT_ID_PATTERN.test(account ?? '')) {
      throw new BadRequestException('Unknown account');
    }
    if (account === 'default') return this.removeDefault(ownerId, id, engine);
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const capability = ACCOUNT_REMOVE_CAPABILITIES[engine];
    if (!runner.capabilitiesReportedAt || !(runner.capabilities ?? []).includes(capability)) {
      throw new BadRequestException(ACCOUNT_REMOVE_TOO_OLD[engine]);
    }
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        accountRemoveEngine: engine,
        codexAccountRemoveAccount: account,
        codexAccountRemoveStatus: 'pending',
        codexAccountRemoveMessage: null,
        codexAccountRemoveAt: new Date(),
      },
    });
    // Delivered on the runner's next heartbeat; have that be now, as for a sign-in.
    this.realtime?.notifyRunnerWake(id);
    return accountRemoveStateOf(r);
  }

  /**
   * Remove this runner's Default of `engine` from Orbit. The machine keeps it and its sign-in, and the
   * CLI in a terminal there keeps working on it; Orbit stops listing and using it. Orbit's own record,
   * kept in `runner.default_removed`, so the runner takes no part: no relay row, no wake, no
   * capability to declare, and it can be offline. The answer is the removal done, at once.
   *
   * Only while the runner reports another account of that engine: Default is otherwise the one
   * account Orbit has there, and is refused in words that say what to do first. The engine goes into
   * the list in the statement itself, once however often it is asked, so two removals at once cannot
   * lose either.
   */
  private async removeDefault(ownerId: string, id: string, engine: LoginEngine): Promise<RunnerAccountRemoveState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId }, select: { engines: true } });
    if (!runner) throw new NotFoundException('runner not found');
    const another = sanitizeRunnerEngines(runner.engines)
      ?.find((entry) => entry.engine === engine)
      ?.accounts?.some((entry) => entry.id !== 'default');
    if (!another) {
      throw new BadRequestException(`Add another ${ENGINE_LABELS[engine]} account to this machine before removing Default.`);
    }
    const written = await this.prisma.$executeRaw`
      UPDATE "runner"
         SET "default_removed" = CASE
               WHEN ${engine}::text = ANY("default_removed") THEN "default_removed"
               ELSE array_append("default_removed", ${engine}::text)
             END
       WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid`;
    if (written === 0) throw new NotFoundException('runner not found');
    return { engine, account: 'default', status: 'done', message: null };
  }

  /**
   * Bring this runner's Default of `engine` back into Orbit, after removeAccount removed it: the
   * engine comes out of `runner.default_removed` in one statement. Orbit's own record, so the runner
   * need not be online, and bringing back a Default that is not removed is the same state, not an
   * error.
   */
  async restoreDefault(ownerId: string, id: string, engine: LoginEngine): Promise<{ ok: true }> {
    if (!engineKeepsAccounts(engine)) {
      throw new BadRequestException(`Only an engine that keeps accounts has a Default to bring back`);
    }
    const written = await this.prisma.$executeRaw`
      UPDATE "runner"
         SET "default_removed" = array_remove("default_removed", ${engine}::text)
       WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid`;
    if (written === 0) throw new NotFoundException('runner not found');
    return { ok: true };
  }

  /**
   * Dismiss this runner's update warning for `engine` until its next release: the engine's current
   * `update.latest`, as the runner last reported it, goes into its key of
   * `runner.engine_update_dismissals` in one statement. Clients hide the warning while that equals
   * the engine's `update.latest`, so a newer release brings it back by itself. Orbit's own record:
   * the runner need not be online and is not woken, and Orbit keeps retrying the update on it.
   * Refused when no release is known to dismiss against.
   */
  async dismissEngineUpdateWarning(
    ownerId: string,
    id: string,
    engine: ReportedEngine,
  ): Promise<{ engine: ReportedEngine; latest: string }> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId }, select: { engines: true } });
    if (!runner) throw new NotFoundException('runner not found');
    const latest = sanitizeRunnerEngines(runner.engines)?.find((entry) => entry.engine === engine)?.update?.latest;
    if (!latest) throw new BadRequestException('This engine reports no newer release to dismiss its warning until');
    const written = await this.prisma.$executeRaw`
      UPDATE "runner"
         SET "engine_update_dismissals" =
               COALESCE("engine_update_dismissals", '{}'::jsonb) || jsonb_build_object(${engine}::text, ${latest}::text)
       WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid`;
    if (written === 0) throw new NotFoundException('runner not found');
    return { engine, latest };
  }

  /**
   * Rename one account a runner reports — Default included, which the machine itself never names.
   *
   * Only a label, and Orbit's own: kept in `runner.account_names` and laid over the report wherever
   * an account is named (namedRunnerEngines), so nothing on the machine changes, the runner need not
   * be online, and no runner has to be new enough to understand it. The name goes into its one key in
   * the statement itself, so two accounts renamed at once cannot lose either name. A name equal to the
   * one the account carries anyway — what the runner reports for it, or "Default" — removes the key
   * instead: that is how Default goes back to being Default. Returns the account as the runner list
   * now shows it.
   */
  async renameAccount(
    ownerId: string,
    id: string,
    engine: LoginEngine,
    account: string,
    name: string,
  ): Promise<RunnerEngineAccount> {
    if (!engineKeepsAccounts(engine)) {
      throw new BadRequestException(`Only an engine that keeps accounts can rename one`);
    }
    if (!ACCOUNT_ID_PATTERN.test(account ?? '')) {
      throw new BadRequestException('Unknown account');
    }
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new BadRequestException('An account needs a name');
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId }, select: { engines: true } });
    if (!runner) throw new NotFoundException('runner not found');
    const reported = sanitizeRunnerEngines(runner.engines)
      ?.find((entry) => entry.engine === engine)
      ?.accounts?.find((entry) => entry.id === account);
    if (!reported) throw new NotFoundException('That account is not one this runner reports');
    const own = reported.name || (account === 'default' ? 'Default' : '');
    const alias = trimmed === own ? null : trimmed;
    const written = await this.prisma.$executeRaw`
      UPDATE "runner"
         SET "account_names" = CASE
               WHEN ${alias}::text IS NULL
                 THEN COALESCE("account_names", '{}'::jsonb) #- ARRAY[${engine}::text, ${account}::text]
               ELSE jsonb_set(
                      COALESCE("account_names", '{}'::jsonb),
                      ARRAY[${engine}::text],
                      COALESCE("account_names" -> ${engine}::text, '{}'::jsonb)
                        || jsonb_build_object(${account}::text, ${alias}::text))
             END
       WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid`;
    if (written === 0) throw new NotFoundException('runner not found');
    return alias ? { ...reported, name: alias } : reported;
  }

  async pauseAccount(
    ownerId: string, id: string, engine: LoginEngine, account: string, durationMinutes: number | null,
  ): Promise<RunnerEngineAccount> {
    if (!engineKeepsAccounts(engine) || !ACCOUNT_ID_PATTERN.test(account ?? '')) {
      throw new BadRequestException('Unknown account');
    }
    const pausedUntil = accountPauseUntil(durationMinutes);
    const runner = await this.prisma.runner.findFirst({
      where: { id, ownerId }, select: { engines: true, accountNames: true },
    });
    if (!runner) throw new NotFoundException('runner not found');
    const reported = namedRunnerEngines(runner)?.find((entry) => entry.engine === engine)
      ?.accounts?.find((entry) => entry.id === account);
    if (!reported) throw new NotFoundException('That account is not one this runner reports');
    const until = pausedUntil?.toISOString() ?? null;
    const written = await this.prisma.$executeRaw`
      UPDATE "runner"
         SET "account_pauses" = CASE
               WHEN ${until}::text IS NULL
                 THEN COALESCE("account_pauses", '{}'::jsonb) #- ARRAY[${engine}::text, ${account}::text]
               ELSE jsonb_set(
                      COALESCE("account_pauses", '{}'::jsonb), ARRAY[${engine}::text],
                      COALESCE("account_pauses" -> ${engine}::text, '{}'::jsonb)
                        || jsonb_build_object(${account}::text, ${until}::text))
             END
       WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid`;
    if (written === 0) throw new NotFoundException('runner not found');
    return { ...reported, pausedUntil: until };
  }

  /** @deprecated Codex's route; read removeAccount. */
  removeCodexAccount(ownerId: string, id: string, account: string): Promise<RunnerAccountRemoveState> {
    return this.removeAccount(ownerId, id, 'codex', account);
  }

  /**
   * Ask this runner to install one engine's CLI. The next heartbeat picks it up; the runner
   * reports the command it is running, then whether it worked.
   *
   * This is deliberately not the same thing as the runner's on-demand install, which only runs
   * on a machine that consented at register time (RunnerConfig.AutoInstallEngines) and otherwise
   * fails the session with "not installed" and no way forward from the UI. Pressing Install here
   * IS the consent, for this engine on this machine, so the runner honours it either way.
   *
   * One at a time per machine, like the sign-in relay: a second request replaces the first, since
   * a user staring at a stuck row needs a way out that isn't waiting for a timeout.
   *
   * Cursor CLI's install, Reinstall included, goes only to a runner that knows Cursor CLI
   * (runnerKnowsCursor), and any other is refused here in words that say to update it: an older one has
   * no install for it. The heartbeat asks the polling process again (drainInstallRequest).
   */
  async startInstall(ownerId: string, id: string, engine: InstallEngine): Promise<RunnerInstallState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only install while connected');
    }
    if (engine === 'antigravity' && !antigravityState(runner).supported) {
      throw new BadRequestException('Antigravity needs Orbit runner 0.1.209 or newer — updates itself when idle');
    }
    if (engine === 'cursor' && !runnerKnowsCursor(runner)) {
      throw new BadRequestException(CURSOR_RUNNER_UPGRADE_ERROR);
    }
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        installStatus: 'pending',
        installEngine: engine,
        installCommand: null,
        installMessage: null,
        installAt: new Date(),
        installMode: 'install',
      },
    });
    // The heartbeat hands the install over: over the runner link, the next one is told so (markRunnerChanged).
    this.realtime?.markRunnerChanged(id);
    return installStateOf(r);
  }

  /**
   * Ask this runner to update every engine CLI on it, now.
   *
   * The same work the runner already does on its own every 30 min — this is the escape hatch for when
   * that isn't soon enough, or when it has been failing and someone wants to watch it try. It
   * shares the install relay's one slot deliberately: both drive a package manager against that
   * machine's single global prefix.
   *
   * Engines with a live session are skipped by the runner and named in the summary, so a machine
   * that is busy says so rather than quietly doing less than the button implied.
   */
  async startEngineUpdate(ownerId: string, id: string): Promise<RunnerInstallState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only update while connected');
    }
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        installStatus: 'pending',
        // Not one engine's business: the row this reports into is the machine's.
        installEngine: null,
        installCommand: null,
        installMessage: null,
        installAt: new Date(),
        installMode: 'update',
      },
    });
    this.realtime?.markRunnerChanged(id);
    return installStateOf(r);
  }

  /**
   * Ask this runner to re-read what models its runtime CLIs offer, now.
   *
   * The model picker lists what the machine's own CLIs report, refreshed by the runner on a timer —
   * hourly, and on the spot after it installs a newer engine, so the gap this closes is a model a
   * CLI learned about some other way.
   * This is the escape hatch, in the same spirit as the engine update next to it.
   *
   * Nothing is reported back: the refreshed catalog arrives on a later heartbeat as
   * `modelCatalog`, which is the answer. So this writes one timestamp and the next heartbeat
   * clears it — no relay state to get stuck, and a second press before the first is picked up is
   * simply the same single request with a newer date.
   */
  async requestModelCatalogRefresh(ownerId: string, id: string): Promise<{ requestedAt: string }> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only refresh while connected');
    }
    const requestedAt = new Date();
    await this.prisma.runner.update({ where: { id }, data: { modelCatalogRefreshAt: requestedAt } });
    this.realtime?.markRunnerChanged(id);
    return { requestedAt: requestedAt.toISOString() };
  }

  /**
   * Ask this runner to check for a release of itself now — Update Runner Now — rather than at its
   * next periodic check, up to ten minutes away.
   *
   * It is the runner's own check, so its rules hold: it installs the release the control plane
   * assigns it (a staged rollout can still hold it back), and never while a turn is in flight —
   * then it reports `waitingForIdle` and updates once a check finds it idle. As with the model
   * catalog refresh, that state on later heartbeats is the only answer, so this writes one
   * timestamp the next heartbeat clears as it hands the request over — and wakes the runner, so
   * that heartbeat is now rather than up to half a minute from now.
   *
   * A runner that does not report its self-update state is refused: it is a release from before
   * this request, which would take it from the heartbeat and do nothing with it.
   */
  async requestSelfUpdate(ownerId: string, id: string): Promise<{ requestedAt: string }> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only update while connected');
    }
    if (!sanitizeRunnerSelfUpdate(runner.selfUpdate)) {
      throw new BadRequestException('Runner is too old to update on request — it reports no self-update state');
    }
    const requestedAt = new Date();
    await this.prisma.runner.update({ where: { id }, data: { selfUpdateRequestedAt: requestedAt } });
    this.realtime?.notifyRunnerWake(id);
    return { requestedAt: requestedAt.toISOString() };
  }

  /**
   * Update Now (docs/runner-update-drain-design.md §4, D4): install the release this runner waits
   * for now, interrupting the turns in flight. The runner stops them through its graceful stop, so
   * each session stays resumable, installs, restarts and reclaims them; the control plane then hands
   * each one its interrupted turn again as the update's continuation (dequeueTurn). Like Update
   * Runner Now, the request is one timestamp the next heartbeat hands over (`selfUpdateNow`) and
   * clears, and the runner's report — phase `restarting` with `interruptedTurns` — is the answer.
   *
   * The owner's alone, and only with `interruptTurns: true`: the owner's explicit word is what lets
   * it interrupt a turn, which an automatic update never does. Each request is recorded as a
   * `runner.self_update.now` activity, naming the owner's turns it interrupts, before it is stored. A
   * runner that does not declare self-update-now/v1 would drop it unread, and is refused with Update
   * Runner Now's "too old" sentence; one with no release waiting has nothing to install.
   */
  async updateSelfNow(
    ownerId: string,
    id: string,
    body: RunnerSelfUpdateNowRequest | undefined,
  ): Promise<RunnerSelfUpdateNowResponse> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (body?.interruptTurns !== true) {
      throw new BadRequestException('interruptTurns must be true: Update Now interrupts the turns in flight');
    }
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only update while connected');
    }
    if (!runner.capabilities.includes(SELF_UPDATE_NOW_V1)) {
      throw new BadRequestException('Runner is too old to update on request — it reports no self-update state');
    }
    const report = sanitizeRunnerSelfUpdate(runner.selfUpdate);
    const phase = report?.phase;
    if (phase !== 'available' && phase !== 'draining' && phase !== 'postponed') {
      throw new BadRequestException('No update is waiting on this runner — there is nothing to install');
    }
    const turns = (await this.updateTurnsOf(ownerId, [{ id, selfUpdate: runner.selfUpdate, heartbeatDraining: true }])).get(id) ?? [];
    const requestedAt = new Date();
    await this.prisma.activity.create({
      data: {
        actorId: ownerId,
        type: RUNNER_SELF_UPDATE_NOW_ACTIVITY,
        payload: {
          runnerId: id,
          interruptTurns: true,
          phase,
          targetVersion: report?.targetVersion ?? null,
          sessionIds: turns.map((turn) => turn.id),
        },
        credentialKind: 'LOGIN',
      },
    });
    await this.prisma.runner.update({ where: { id }, data: { selfUpdateNowRequestedAt: requestedAt } });
    this.realtime?.notifyRunnerWake(id);
    return { requestedAt: requestedAt.toISOString(), turns: turns.length };
  }

  /**
   * Later (docs/runner-update-drain-design.md §4): put the release this runner waits to install off
   * until `until`. The runner ends its drain at once and takes work again, and at `until` waits for
   * idle again under a fresh one-hour limit. Like Update Runner Now, the request is one timestamp the
   * next heartbeat hands over (`postponeSelfUpdateUntil`) and clears, and the runner's report —
   * phase `postponed` with `postponedUntil` — is the answer.
   *
   * `until` is capped at 09:00 tomorrow in the owner's zone (D2), which the client names. Owner only;
   * each request is recorded as a `runner.self_update.postponed` activity before it is stored. A
   * runner that does not declare self-update-postpone/v1 would drop it unread, and is refused with
   * Update Runner Now's "too old" sentence; one with no release waiting has nothing to postpone.
   */
  async postponeSelfUpdate(
    ownerId: string,
    id: string,
    body: RunnerSelfUpdatePostponeRequest | undefined,
  ): Promise<RunnerSelfUpdatePostponeResponse> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only postpone its update while connected');
    }
    if (!runner.capabilities.includes(SELF_UPDATE_POSTPONE_V1)) {
      throw new BadRequestException('Runner is too old to update on request — it reports no self-update state');
    }
    const report = sanitizeRunnerSelfUpdate(runner.selfUpdate);
    const phase = report?.phase;
    if (phase !== 'available' && phase !== 'draining' && phase !== 'postponed') {
      throw new BadRequestException('No update is waiting on this runner — there is nothing to postpone');
    }
    const now = new Date();
    const { until, capped } = postponeUntil(now, body);
    await this.prisma.activity.create({
      data: {
        actorId: ownerId,
        type: RUNNER_SELF_UPDATE_POSTPONED_ACTIVITY,
        payload: {
          runnerId: id,
          until: until.toISOString(),
          asked: typeof body?.until === 'string' ? body.until : null,
          timeZone: typeof body?.timeZone === 'string' ? body.timeZone : null,
          capped,
          phase,
          targetVersion: report?.targetVersion ?? null,
        },
        credentialKind: 'LOGIN',
      },
    });
    await this.prisma.runner.update({ where: { id }, data: { selfUpdatePostponeUntil: until } });
    this.realtime?.notifyRunnerWake(id);
    return { until: until.toISOString() };
  }

  /**
   * Check again (docs/claude-region-check-contract.md §7): have this runner check where its Claude connection to
   * Anthropic comes out now, rather than at its next check, up to five minutes away.
   *
   * It writes one timestamp, which every heartbeat of the runner hands over as `regionCheckRequest` until a check at or
   * after it reaches GET /runner/region-check, and wakes the runner so that heartbeat is now. It answers with that
   * timestamp; the check's result lands in runner.region like any other. A second press before a check has answered the
   * first asks again with a newer date, which the runner checks once more for.
   *
   * Refused while the machine is offline, as the runner list reads it (`online`): nothing would answer. Refused for a
   * runner that does not declare claude-region/v1: it would never check, and the request would wait for nothing.
   */
  async requestRegionCheck(ownerId: string, id: string): Promise<ClaudeRegionCheckRequest> {
    const runner = await this.prisma.runner.findFirst({
      where: { id, ownerId },
      select: { status: true, capabilities: true, ...RUNNER_BEATS },
    });
    if (!runner) throw new NotFoundException('runner not found');
    if (!runnerIsOnline(runner)) {
      throw new BadRequestException('Runner is offline — it can only check while connected');
    }
    if (!runner.capabilities.includes(CLAUDE_REGION_V1)) {
      throw new BadRequestException('Runner is too old to check its Claude region — update it, then try again.');
    }
    const requestedAt = new Date();
    await this.prisma.runner.update({ where: { id }, data: { regionCheckRequestedAt: requestedAt } });
    this.realtime?.notifyRunnerWake(id);
    return { requestedAt: requestedAt.toISOString() };
  }

  /**
   * Ask this runner what local Claude Code conversations already sit under a directory.
   *
   * Only the runner can answer: `~/.claude/projects` is on its disk and the control plane never
   * sees it. Unlike the per-workspace directory probe, this names a bare path — it is asked while
   * a directory is being typed into the new-workspace form, before there is a workspace row to
   * key an answer to.
   *
   * One slot per machine, like the sign-in and install relays, because it answers whatever path
   * was typed last: a second ask replaces the first rather than queueing behind it. The previous
   * answer is deliberately left in place — `getClaudeHistory` only ever returns one whose path
   * matches what was asked, so re-asking about the same directory shows the last answer at once
   * while a fresh scan runs, and an answer about a different one is never shown at all.
   */
  async requestClaudeHistory(ownerId: string, id: string, workDir: string) {
    const path = (workDir ?? '').trim();
    if (!path) throw new BadRequestException('workDir is required');
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only look while connected');
    }
    await this.prisma.runner.update({
      where: { id },
      data: { claudeHistoryStatus: 'pending', claudeHistoryPath: path, claudeHistoryAt: new Date() },
    });
    this.realtime?.markRunnerChanged(id);
    return { workDir: path, status: 'pending' };
  }

  /**
   * What this runner last reported for a directory — the answer the new-workspace form waits on.
   *
   * The stored answer is returned ONLY when it is about the path being asked about, checked at
   * both ends (the request the relay holds, and the path inside the answer itself). A form where
   * someone keeps typing asks about several directories in a row, and an answer arriving late for
   * an abandoned one must read as nothing-yet rather than as the verdict on what is in the field
   * now — offering to import another project's history would be the worst possible misread.
   */
  async getClaudeHistory(ownerId: string, id: string, workDir: string) {
    const path = (workDir ?? '').trim();
    const runner = await this.prisma.runner.findFirst({
      where: { id, ownerId },
      select: {
        claudeHistoryStatus: true,
        claudeHistoryPath: true,
        claudeHistoryAt: true,
        claudeHistoryResult: true,
      },
    });
    if (!runner) throw new NotFoundException('runner not found');
    const asked = (runner.claudeHistoryPath ?? '').trim();
    const stored = runner.claudeHistoryResult as { workDir?: string } | null;
    const answers = !!path && asked === path && stored?.workDir === path;
    return {
      workDir: path,
      // 'pending' while the runner has yet to answer; the form polls on that and stops on the
      // rest. A machine that has never been asked reports 'idle' rather than an empty string.
      status: asked === path ? (runner.claudeHistoryStatus ?? 'idle') : 'idle',
      requestedAt: asked === path ? (runner.claudeHistoryAt?.toISOString() ?? null) : null,
      result: answers ? stored : null,
    };
  }

  /**
   * Ask this runner what is at a path on its disk: the folder a machine's first workspace would run in, asked while it
   * is being chosen (docs/first-workspace-contract.md §2.1).
   *
   * The Claude history relay's shape, for its reasons: only the runner can look, there is no workspace row yet to key an
   * answer to, and it answers whatever path was asked last — one slot per machine, a second ask replacing the first.
   * The previous answer stays in the row; `getDirProbe` only ever returns one about the path it is asked for.
   *
   * Refused while the machine is offline, as the runner list reads it (`online`): nothing would answer.
   */
  async requestDirProbe(ownerId: string, id: string, asked: unknown) {
    const path = typeof asked === 'string' ? asked.trim() : '';
    if (!path) throw new BadRequestException('path is required');
    if (path.length > DIR_PROBE_MAX_PATH) {
      throw new BadRequestException(`path is longer than ${DIR_PROBE_MAX_PATH} characters`);
    }
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId }, select: { status: true, ...RUNNER_BEATS } });
    if (!runner) throw new NotFoundException('runner not found');
    if (!runnerIsOnline(runner)) {
      throw new BadRequestException('Runner is offline — it can only look while connected');
    }
    await this.prisma.runner.update({
      where: { id },
      data: { dirProbeStatus: 'pending', dirProbePath: path, dirProbeAt: new Date() },
    });
    // Someone is watching the folder they typed, as with a sign-in (startLogin): the runner picks the
    // question up on a heartbeat now rather than up to half a minute from now.
    this.realtime?.notifyRunnerWake(id);
    return { path, status: 'pending' as const };
  }

  /**
   * What this runner last reported about a path — the answer the folder picker waits on
   * (docs/first-workspace-contract.md §2.2): only ever one about the path asked for (dirProbeAnswerOf).
   */
  async getDirProbe(ownerId: string, id: string, asked: unknown): Promise<DirProbeAnswer> {
    const path = typeof asked === 'string' ? asked.trim() : '';
    const runner = await this.prisma.runner.findFirst({
      where: { id, ownerId },
      select: { dirProbeStatus: true, dirProbePath: true, dirProbeResult: true },
    });
    if (!runner) throw new NotFoundException('runner not found');
    return dirProbeAnswerOf(runner, path);
  }

  /** The machine's resources as its presence row keeps them (runner-resources.ts). */
  async getResources(ownerId: string, id: string): Promise<RunnerResourcesAnswer> {
    const runner = await this.prisma.runner.findFirst({
      where: { id, ownerId },
      select: { presence: { select: { resources: true } } },
    });
    if (!runner) throw new NotFoundException('runner not found');
    return runnerResourcesAnswerOf(runner.presence?.resources);
  }

  /** Current install-relay state, for the row to poll. */
  async getInstallState(ownerId: string, id: string): Promise<RunnerInstallState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    return installStateOf(runner);
  }

  /**
   * Clear an install from the row so its state stops being reported.
   *
   * Note what this does not do: the installer already running on that machine keeps going —
   * `sh -c "curl … | bash"` is not ours to interrupt halfway, and a half-installed CLI is worse
   * than a finished one. This dismisses the row's state; the next heartbeat's engine probe
   * reports whatever actually ended up on disk.
   */
  async cancelInstall(ownerId: string, id: string): Promise<RunnerInstallState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        installStatus: null,
        installEngine: null,
        installCommand: null,
        installMessage: null,
        installAt: null,
        installMode: null,
      },
    });
    return installStateOf(r);
  }

  async rotateToken(ownerId: string, id: string) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    await refuseManagedRunnerRotation(this.prisma, id);
    const token = generateToken(32);
    await this.prisma.runner.update({ where: { id }, data: { tokenHash: sha256(token) } });
    return { token };
  }

  async removeRunner(ownerId: string, id: string) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    await refuseManagedRunnerDeletion(this.prisma, id);
    await this.prisma.runner.delete({ where: { id } });
    return { ok: true };
  }
}

/** Project a runner row onto the browser-facing install-relay view. */
export function installStateOf(r: {
  installStatus: string | null;
  installEngine: string | null;
  installCommand: string | null;
  installMessage: string | null;
  installMode?: string | null;
}): RunnerInstallState {
  return {
    status: (r.installStatus as RunnerInstallState['status']) ?? null,
    engine: r.installStatus ? ((r.installEngine as InstallEngine) ?? null) : null,
    command: r.installCommand,
    message: r.installMessage,
    // A row written before updates shared this relay is an install, which is also what a client
    // that doesn't know about modes assumes.
    mode: r.installStatus ? (r.installMode === 'update' ? 'update' : 'install') : null,
  };
}

/** What a runner that does not declare account removal is told: the machine cannot do this, and
 *  the only thing that changes that is updating it. The heartbeat refuses the same request in the
 *  same words — it cannot import this one, since that file already imports this module. */
const ACCOUNT_REMOVE_TOO_OLD: Record<string, string> = {
  codex: 'This runner is too old to remove a Codex account — update it, then try again.',
  claude: 'This runner is too old to remove a Claude account — update it, then try again.',
  antigravity: 'This runner is too old to remove an Antigravity account — update it, then try again.',
  kimi: 'This runner is too old to remove a Kimi account — update it, then try again.',
  cursor: 'This runner is too old to remove a Cursor account — update it, then try again.',
};

/** The capability each engine's removal needs the runner to declare. */
const ACCOUNT_REMOVE_CAPABILITIES: Record<string, string> = {
  codex: CODEX_ACCOUNT_REMOVE_V1,
  claude: CLAUDE_ACCOUNT_REMOVE_V1,
  antigravity: ANTIGRAVITY_ACCOUNT_REMOVE_V1,
  kimi: KIMI_ACCOUNT_REMOVE_V1,
  cursor: CURSOR_ACCOUNT_REMOVE_V1,
};

/** Project a runner row onto the browser-facing account-removal view. */
export function accountRemoveStateOf(r: {
  accountRemoveEngine?: string | null;
  codexAccountRemoveAccount?: string | null;
  codexAccountRemoveStatus?: string | null;
  codexAccountRemoveMessage?: string | null;
}): RunnerAccountRemoveState {
  return {
    // A row written before accounts-per-engine meant Codex.
    engine: (r.accountRemoveEngine as LoginEngine) ?? 'codex',
    account: r.codexAccountRemoveStatus ? (r.codexAccountRemoveAccount ?? null) : null,
    status: (r.codexAccountRemoveStatus as RunnerAccountRemoveState['status']) ?? null,
    message: r.codexAccountRemoveStatus ? (r.codexAccountRemoveMessage ?? null) : null,
  };
}

/** Project a runner row onto the browser-facing relay view (no code, ever). */
function loginStateOf(r: {
  loginStatus: string | null;
  loginEngine: string | null;
  loginAccount?: string | null;
  loginUrl: string | null;
  loginUserCode: string | null;
  loginMessage: string | null;
  loginExpiresAt?: Date | null;
  loginReason?: string | null;
}): RunnerLoginState {
  // A cancel still owed to the runner (cancelLogin) is a sign-in the user has already dismissed.
  const status = r.loginStatus === 'cancelling' ? null : r.loginStatus;
  const waiting = status === 'awaiting_code' || status === 'awaiting_approval';
  const reason = LOGIN_FAILURE_REASONS.find((known) => known === r.loginReason);
  return {
    status: (status as RunnerLoginState['status']) ?? null,
    // A row written before the relay drove anything but claude carries no engine.
    engine: status ? ((r.loginEngine as LoginEngine) ?? 'claude') : null,
    userCode: r.loginUserCode,
    url: r.loginUrl,
    message: r.loginMessage,
    account: status ? (r.loginAccount ?? null) : null,
    // As the runner reported them (RunnerApiController.loginResult): how long the link lasts while one
    // is waiting, and why a sign-in failed when a client answers that differently.
    ...(waiting && r.loginExpiresAt ? { expiresAt: r.loginExpiresAt.toISOString() } : {}),
    ...(status === 'failed' && reason ? { reason } : {}),
  };
}

/**
 * A device enrollment nobody has decided is open to whoever holds its code — that is the device
 * flow. Once approved or denied it is its decider's (`approvedById` names them either way): to every
 * other account the code is one that names nothing, so its machine's name and host, and whether it
 * exists at all, stay the decider's.
 */
function decidedByAnother(s: { status: string; approvedById: string | null }, ownerId: string): boolean {
  return s.status !== 'PENDING' && s.approvedById !== ownerId;
}

/**
 * The answer to deciding a device enrollment already decided — by this account, since any other is
 * answered 404 before it gets here: the same decision is answered as it stands, the other is a 409
 * that says what it was.
 */
function deviceDecidedAlready(
  s: { status: string; name: string; runnerId: string | null },
  wanted: 'APPROVED' | 'DENIED',
) {
  const decision = s.status === 'DENIED' ? 'DENIED' : 'APPROVED';
  if (decision === wanted) {
    return decision === 'APPROVED'
      ? { ok: true, name: s.name, replaced: false, runnerId: s.runnerId }
      : { ok: true, name: s.name };
  }
  throw new ConflictException({
    code: 'DEVICE_ENROLLMENT_DECIDED',
    message:
      decision === 'DENIED'
        ? 'This registration request was denied — run `orbit register` again'
        : 'This registration request was already approved',
  });
}
