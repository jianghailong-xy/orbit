import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  InstallEngine,
  LoginEngine,
  RunnerAccountRemoveState,
  RunnerEngineAccount,
  RunnerInstallState,
  RunnerLoginState,
  SlashCommandInfo,
} from '@orbit/shared';
import { generateToken, sha256 } from '../common/crypto.util';
import { namedRunnerEngines, sanitizeRunnerEngines } from '../common/runner-engines';
import {
  antigravityGoogleLoginRefusal,
  antigravitySignInUnderWay,
  antigravityState,
} from '../common/antigravity-readiness';
import { sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { sanitizeRunnerSelfUpdate } from '../common/runner-self-update';
import { ACTIVE_TURN_STATUSES } from '../common/session-scheduling';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CLAUDE_ACCOUNT_REMOVE_V1,
  ANTIGRAVITY_ACCOUNT_REMOVE_V1,
  CODEX_ACCOUNT_REMOVE_V1,
  KIMI_ACCOUNT_REMOVE_V1,
  LOGIN_RELAY_TIMEOUT_MS,
} from '../runner-api/runner-api.controller';
import { loginCodeRelay } from './login-code-relay';
import { engineKeepsAccounts } from '../common/runner-engines';
import { ACCOUNT_ID_PATTERN, CreateEnrollmentTokenDto, StartLoginDto, UpdateRunnerDto } from './dto';
import { accountPauseUntil } from '../common/account-pause';
import { refuseManagedRunnerDeletion } from '../managed-runners/managed-runner-delete';

// Three missed 30s heartbeats — a runner quieter than this reads as offline.
const OFFLINE_AFTER_MS = 90_000;
// Cap device-enrollment userCode lookups per user, so an authenticated insider
// cannot brute-force another user's pending enrollment code online.
const DEVICE_LOOKUP_WINDOW_MS = 5 * 60_000;
const DEVICE_LOOKUP_MAX = 20;

/**
 * Is this machine reachable right now?
 *
 * Exported because "online" has to mean the same thing everywhere it decides something. The
 * runners list renders it; the clone-target list REFUSES on it (a clone runs on the machine, so an
 * offline one is not a slower choice, it is not a choice). Two spellings of this rule would drift
 * into a picker that offers a machine the create call then rejects.
 */
export function isRunnerOnline(
  runner: { status: string; lastHeartbeatAt: Date | null },
  now: number = Date.now(),
): boolean {
  return (
    runner.status !== 'OFFLINE' &&
    !!runner.lastHeartbeatAt &&
    runner.lastHeartbeatAt.getTime() >= now - OFFLINE_AFTER_MS
  );
}

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
        // Reported too: why this runner is or isn't updating itself, for its card on Infrastructure
        // and its Update Runner Now. Re-sanitized below, null for a runner that does not report it.
        selfUpdate: true,
        // The runner page's Capacity › Keep Free reads the floor it writes (PATCH minFreeDiskMb),
        // and About › Repos Folder shows where this machine clones to (reported, not configured).
        minFreeDiskMb: true,
        reposRoot: true,
        // What Codex rate-limit reset admission reads about this machine
        // (docs/codex-rate-limit-reset-contract.md §4, §6.1). The web disables its reset entry on
        // the same codexResetRefusal answer the create route refuses with, so it needs the same
        // inputs: the declared capabilities and the last heartbeat's lease owner and draining flag.
        capabilities: true,
        heartbeatLeaseOwner: true,
        heartbeatDraining: true,
        // Per-engine health, and any install the user started for one of them — both drive the
        // engine rows under each machine on Infrastructure. The accounts carry the names given
        // them here (namedRunnerEngines), not only the ones the runner reports.
        engines: true,
        accountNames: true,
        accountPauses: true,
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
    return runners.map(({
      availableCommands,
      availableSkills,
      runtimeDefaultModels,
      engines,
      accountNames,
      accountPauses,
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
      ...r
    }) => ({
      ...r,
      // Never expose null or malformed JSON: clients can always index this as a provider map.
      runtimeDefaultModels: sanitizeRuntimeDefaultModels(runtimeDefaultModels),
      selfUpdate: sanitizeRunnerSelfUpdate(selfUpdate),
      // null (not []) for a runner that has never reported: "we don't know yet" and "nothing is
      // installed" are different answers, and only one of them is ours to make up.
      engines: namedRunnerEngines({ engines, accountNames, accountPauses }),
      antigravity: antigravityState({ capabilities: r.capabilities, engines }),
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
      online: isRunnerOnline(r, now),
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

  /** Details shown on the browser approval page for an `orbit register` session. */
  async getDeviceEnrollment(ownerId: string, userCode: string) {
    this.rateLimitDeviceLookup(ownerId);
    const s = await this.prisma.deviceEnrollment.findUnique({ where: { userCode } });
    if (!s || s.expiresAt < new Date() || approvedByAnother(s, ownerId)) {
      throw new NotFoundException('enrollment request not found or expired');
    }
    // Warn (don't block) if a runner with this name is already registered, so the
    // user knows approving re-issues its credential rather than adding a 2nd machine.
    const runnerName = s.name;
    const nameConflict =
      (await this.prisma.runner.count({ where: { ownerId, name: runnerName, managedRunner: { is: null } } })) > 0;
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
    if (!s || s.expiresAt < new Date() || approvedByAnother(s, ownerId)) {
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
    const refusal = engine === 'antigravity' ? antigravityGoogleLoginRefusal(runner) : null;
    if (refusal) throw new BadRequestException(refusal);
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
   * `default` is refused here rather than on the runner: it is the directory the machine's own
   * environment selects, and the one the CLI typed in a terminal shares, so there is nothing to
   * remove without taking the user's own login with it.
   *
   * A runner that has not declared that engine's account-removal capability is refused in words the
   * person who pressed the button can act on — the alternative is a request that sits pending until
   * the relay's timeout and then fails with nothing useful in it. The heartbeat refuses it too, for
   * a runner whose declared capabilities went stale between this call and its next check-in.
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
    if (account === 'default') {
      throw new BadRequestException(
        `Default is this machine's own login, which the CLI in a terminal shares — it cannot be removed`,
      );
    }
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
};

/** The capability each engine's removal needs the runner to declare. */
const ACCOUNT_REMOVE_CAPABILITIES: Record<string, string> = {
  codex: CODEX_ACCOUNT_REMOVE_V1,
  claude: CLAUDE_ACCOUNT_REMOVE_V1,
  antigravity: ANTIGRAVITY_ACCOUNT_REMOVE_V1,
  kimi: KIMI_ACCOUNT_REMOVE_V1,
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
}): RunnerLoginState {
  // A cancel still owed to the runner (cancelLogin) is a sign-in the user has already dismissed.
  const status = r.loginStatus === 'cancelling' ? null : r.loginStatus;
  return {
    status: (status as RunnerLoginState['status']) ?? null,
    // A row written before the relay drove anything but claude carries no engine.
    engine: status ? ((r.loginEngine as LoginEngine) ?? 'claude') : null,
    userCode: r.loginUserCode,
    url: r.loginUrl,
    message: r.loginMessage,
    account: status ? (r.loginAccount ?? null) : null,
  };
}

/**
 * A device enrollment nobody has approved is open to whoever holds its code — that is the device
 * flow. Once approved it is the approver's: to every other account the code is one that names
 * nothing, so its machine's name and host, and whether it exists at all, stay the approver's.
 */
function approvedByAnother(s: { status: string; approvedById: string | null }, ownerId: string): boolean {
  return s.status === 'APPROVED' && s.approvedById !== ownerId;
}
