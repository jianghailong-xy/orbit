import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  LoginEngine,
  RunnerInstallState,
  RunnerLoginState,
  SlashCommandInfo,
} from '@orbit/shared';
import { generateToken, sha256 } from '../common/crypto.util';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { ACTIVE_TURN_STATUSES } from '../common/session-scheduling';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEnrollmentTokenDto, UpdateRunnerDto } from './dto';

// Three missed 30s heartbeats — a runner quieter than this reads as offline.
const OFFLINE_AFTER_MS = 90_000;
// Cap device-enrollment userCode lookups per user, so an authenticated insider
// cannot brute-force another user's pending enrollment code online.
const DEVICE_LOOKUP_WINDOW_MS = 5 * 60_000;
const DEVICE_LOOKUP_MAX = 20;

@Injectable()
export class RunnersService {
  constructor(private readonly prisma: PrismaService) {}

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
    const runners = await this.prisma.runner.findMany({
      where: { ownerId },
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
        lastHeartbeatAt: true,
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
        // Per-engine health, and any install the user started for one of them — both drive the
        // Providers page's "On your runners" section.
        engines: true,
        installStatus: true,
        installEngine: true,
        installCommand: true,
        installMessage: true,
        installMode: true,
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
    const staleBefore = Date.now() - OFFLINE_AFTER_MS;
    return runners.map(({
      availableCommands,
      availableSkills,
      runtimeDefaultModels,
      engines,
      installStatus,
      installEngine,
      installCommand,
      installMessage,
      installMode,
      ...r
    }) => ({
      ...r,
      // Never expose null or malformed JSON: clients can always index this as a provider map.
      runtimeDefaultModels: sanitizeRuntimeDefaultModels(runtimeDefaultModels),
      // null (not []) for a runner that has never reported: "we don't know yet" and "nothing is
      // installed" are different answers, and only one of them is ours to make up.
      engines: sanitizeRunnerEngines(engines),
      install: installStateOf({
        installStatus,
        installEngine,
        installCommand,
        installMessage,
        installMode,
      }),
      online: r.status !== 'OFFLINE' && !!r.lastHeartbeatAt && r.lastHeartbeatAt.getTime() >= staleBefore,
      activeSessions: activeByRunner.get(r.id) ?? 0,
      // Surface the `/` autocomplete catalog under clean names (mirrors the heartbeat DTO).
      commands: (availableCommands ?? []) as unknown as SlashCommandInfo[],
      skills: (availableSkills ?? []) as unknown as SlashCommandInfo[],
    }));
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
    await this.prisma.$transaction(
      ranked.map(({ id, position }) =>
        this.prisma.runner.update({ where: { id }, data: { position } }),
      ),
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

  /** Details shown on the browser approval page for an `orbit register` session. */
  async getDeviceEnrollment(ownerId: string, userCode: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.prisma.deviceEnrollment.findUnique({ where: { userCode } });
    if (!s || s.expiresAt < new Date()) {
      throw new NotFoundException('enrollment request not found or expired');
    }
    // Warn (don't block) if a runner with this name is already registered, so the
    // user knows approving re-issues its credential rather than adding a 2nd machine.
    const runnerName = s.name;
    const nameConflict =
      (await this.prisma.runner.count({ where: { ownerId, name: runnerName } })) > 0;
    return {
      userCode: s.userCode,
      name: s.name,
      hostname: s.hostname,
      labels: s.labels,
      maxConcurrent: s.maxConcurrent,
      status: s.status,
      nameConflict,
      createdAt: s.createdAt,
    };
  }

  /**
   * Approve a device session: mint one Runner for the machine, then stash its
   * credential. Workspaces are registered separately, not here.
   */
  async approveDeviceEnrollment(ownerId: string, userCode: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.prisma.deviceEnrollment.findUnique({ where: { userCode } });
    if (!s || s.expiresAt < new Date()) {
      throw new NotFoundException('enrollment request not found or expired');
    }
    const runnerName = s.name;
    if (s.status === 'APPROVED') {
      return { ok: true, name: runnerName, replaced: false };
    }

    // One Runner per machine. Re-registering reuses the same runner (reissuing its
    // credential) rather than duplicating, so the machine keeps its identity and
    // run history.
    const runnerToken = generateToken(32);
    const data = {
      hostname: s.hostname,
      labels: s.labels,
      maxConcurrent: s.maxConcurrent,
      version: s.version,
      tokenHash: sha256(runnerToken),
      status: 'ONLINE' as const,
      lastHeartbeatAt: new Date(),
    };
    const existing = await this.prisma.runner.findFirst({
      where: { ownerId, name: runnerName },
      orderBy: { enrolledAt: 'desc' },
    });
    const runner = existing
      ? await this.prisma.runner.update({ where: { id: existing.id }, data })
      : await this.prisma.runner.create({ data: { ...data, name: runnerName, ownerId } });

    await this.prisma.deviceEnrollment.update({
      where: { id: s.id },
      data: {
        status: 'APPROVED',
        runnerId: runner.id,
        runnerToken,
        approvedById: ownerId,
        approvedAt: new Date(),
      },
    });
    return { ok: true, name: runnerName, replaced: !!existing };
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
   * new one, and a user staring at a stuck card needs a way out that isn't waiting ten minutes.
   * One relay at a time per runner, so asking for codex while claude's is in flight replaces it.
   */
  async startLogin(ownerId: string, id: string, engine: LoginEngine = 'claude'): Promise<RunnerLoginState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only sign in while connected');
    }
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        loginStatus: 'pending',
        loginEngine: engine,
        loginUrl: null,
        loginUserCode: null,
        loginCode: null,
        loginMessage: null,
        loginAt: new Date(),
      },
    });
    return loginStateOf(r);
  }

  /**
   * Hand the runner the authorization code the user pasted. Stored for the next heartbeat to
   * deliver, then cleared — it is single-use, and useless without the PKCE verifier that never
   * leaves the runner process.
   *
   * Only the paste-back flow ever reaches here: codex's device flow sits in `awaiting_approval`,
   * where the code goes to the browser, not through us.
   */
  async submitLoginCode(ownerId: string, id: string, code: string): Promise<RunnerLoginState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.loginStatus !== 'awaiting_code') {
      throw new BadRequestException('This runner is not waiting for a sign-in code');
    }
    const trimmed = code?.trim();
    if (!trimmed) throw new BadRequestException('Code is empty');
    const r = await this.prisma.runner.update({
      where: { id },
      data: { loginCode: trimmed, loginMessage: null },
    });
    return loginStateOf(r);
  }

  /** Current relay state for the card to poll. */
  async getLoginState(ownerId: string, id: string): Promise<RunnerLoginState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    return loginStateOf(runner);
  }

  /** Abandon an in-flight relay so the card can be dismissed without waiting for the timeout. */
  async cancelLogin(ownerId: string, id: string): Promise<RunnerLoginState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    const r = await this.prisma.runner.update({
      where: { id },
      data: {
        loginStatus: null,
        loginEngine: null,
        loginUrl: null,
        loginUserCode: null,
        loginCode: null,
        loginMessage: null,
        loginAt: null,
      },
    });
    return loginStateOf(r);
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
   */
  async startInstall(ownerId: string, id: string, engine: LoginEngine): Promise<RunnerInstallState> {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.status === 'OFFLINE') {
      throw new BadRequestException('Runner is offline — it can only install while connected');
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
    return installStateOf(r);
  }

  /**
   * Ask this runner to update every engine CLI on it, now.
   *
   * The same work the runner already does daily on its own — this is the escape hatch for when
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
    return installStateOf(r);
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
    const token = generateToken(32);
    await this.prisma.runner.update({ where: { id }, data: { tokenHash: sha256(token) } });
    return { token };
  }

  async removeRunner(ownerId: string, id: string) {
    const runner = await this.prisma.runner.findFirst({ where: { id, ownerId } });
    if (!runner) throw new NotFoundException('runner not found');
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
    engine: r.installStatus ? ((r.installEngine as LoginEngine) ?? null) : null,
    command: r.installCommand,
    message: r.installMessage,
    // A row written before updates shared this relay is an install, which is also what a client
    // that doesn't know about modes assumes.
    mode: r.installStatus ? (r.installMode === 'update' ? 'update' : 'install') : null,
  };
}

/** Project a runner row onto the browser-facing relay view (no code, ever). */
function loginStateOf(r: {
  loginStatus: string | null;
  loginEngine: string | null;
  loginUrl: string | null;
  loginUserCode: string | null;
  loginMessage: string | null;
}): RunnerLoginState {
  return {
    status: (r.loginStatus as RunnerLoginState['status']) ?? null,
    // A row written before the relay drove anything but claude carries no engine.
    engine: r.loginStatus ? ((r.loginEngine as LoginEngine) ?? 'claude') : null,
    userCode: r.loginUserCode,
    url: r.loginUrl,
    message: r.loginMessage,
  };
}
