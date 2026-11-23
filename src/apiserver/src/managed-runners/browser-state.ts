import {
  BadRequestException,
  type CanActivate,
  ConflictException,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Optional,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  BROWSER_CLEAR_V1,
  BROWSER_OPEN_V1,
  LOGIN_RUNNER_BROWSER_V1,
  toUuid,
  uuidToBase62,
  type RunnerBrowserClearResponse,
  type RunnerBrowserOpenResponse,
  type RunnerBrowserReport,
  type RunnerBrowserState,
  type RunnerBrowserStatus,
  type RunnerLoginState,
} from '@orbit/shared';

import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { loginStateOf } from '../runners/login-state';
import { MANAGED_RUNNER_BROWSER_GATE, type ManagedRunnerBrowserGate } from './managed-runner-browser-gate';

/**
 * The managed runner browser's state and Clear saved logins (docs/runner-browser-design.md §5, §6; P4 = the runner's
 * owner only):
 *
 *   GET  /api/runners/:id/browser         whether Chrome is running, the session holding the lease, open viewers,
 *                                         as the runner's last heartbeat reported them (RunnerBrowserState)
 *   GET  /api/runner/browser              the same for a session of the account, by its runner's credential: browser_status
 *                                         and `orbit browser status` (runner-api/runner-browser.controller.ts)
 *   POST /api/runner/browser/clear        the same clear for a session of the account, only against the owner's yes on a
 *                                         card: browser_clear_logins and `orbit browser clear-logins`
 *   POST /api/runner/browser/open         browser_open and `orbit browser open [--url]`, by the same credential: the
 *                                         runner's next heartbeat is handed `openBrowser`, and the runner starts the
 *                                         browser (as for Open browser) and opens the page asked for, if any
 *   POST /api/runners/:id/browser/sign-in Use the runner's browser on an engine's sign-in waiting on its link
 *                                         (docs/runner-browser-engine-sign-in-design.md): the runner's next heartbeat
 *                                         is handed a LoginCommand `browser`, and the runner opens that link in its
 *                                         browser; its report on the attempt is the answer (RunnerLoginState.browser)
 *   POST /api/runners/:id/browser/clear   Clear saved logins: the runner's next heartbeat is handed
 *                                         `clearBrowserProfile`, and the runner stops Chrome and deletes its profile
 *                                         (~/.orbit/browser/profile); its next report's profileClearedAt is the answer
 *
 *   - Behind the browser switch: off, both answer 404 before anything else, as a path the apiserver does not have.
 *   - Only the caller's own managed runner: another account's runner, a self-managed one or none at all is 404, which
 *     says nothing of whether it exists. A session's guests are not the runner's owner.
 *   - The clear is the owner's login only (no personal access token), and only for a runner that declares
 *     browser-clear/v1 (409 otherwise): an older runner would drop it unread. An offline runner keeps it on its row
 *     until it next beats.
 *   - The request rides the heartbeat's command path, like Update Runner Now: one timestamp on the runner row, the
 *     runner woken at once (CommandsHint), the timestamp claimed by the beat that hands it over.
 */

/** Answers 404 while the browser switch is off, as for a path the apiserver does not have. */
@Injectable()
export class ManagedRunnerBrowserEnabledGuard implements CanActivate {
  constructor(@Inject(MANAGED_RUNNER_BROWSER_GATE) private readonly gate: ManagedRunnerBrowserGate) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.gate.enabled) return true;
    const req = context.switchToHttp().getRequest<{ method?: string; url?: string }>();
    throw new NotFoundException(`Cannot ${req.method ?? 'GET'} ${(req.url ?? '').split('?')[0]}`);
  }
}

/** The report as stored on the runner row: what the runner said that this server can read, with the beat's time. */
export interface StoredBrowserState extends RunnerBrowserReport {
  reportedAt: string;
}

const MAX_TEXT = 200;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : undefined;
}

/** A heartbeat's `browser` as it is stored, or null when it sent none or nothing this server can read. */
export function storedBrowserState(report: unknown, beatAt: Date): StoredBrowserState | null {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  const r = report as Record<string, unknown>;
  if (typeof r.running !== 'boolean') return null;
  const viewers = typeof r.viewers === 'number' && Number.isInteger(r.viewers) && r.viewers >= 0 ? Math.min(r.viewers, 1000) : 0;
  const cleared = text(r.profileClearedAt);
  const out: StoredBrowserState = { running: r.running, viewers, reportedAt: beatAt.toISOString() };
  const holder = text(r.holderSessionId);
  if (holder) out.holderSessionId = holder;
  const title = holder ? text(r.holderTitle) : undefined;
  if (title) out.holderTitle = title;
  if (cleared && !Number.isNaN(Date.parse(cleared))) out.profileClearedAt = new Date(cleared).toISOString();
  // A boolean and nothing more: which sites the profile holds logins for is never reported, so never stored.
  if (typeof r.savedLogins === 'boolean') out.savedLogins = r.savedLogins;
  return out;
}

/** The state GET answers, from the runner row's two columns. */
export function browserStateOf(
  runnerId: string,
  row: { browserState: unknown; browserClearRequestedAt: Date | null },
): RunnerBrowserState {
  const stored = storedBrowserState(row.browserState, new Date(0));
  const reportedAt = stored ? text((row.browserState as Record<string, unknown>).reportedAt) ?? null : null;
  return {
    runnerId,
    state: !stored ? 'UNKNOWN' : stored.running ? 'RUNNING' : 'IDLE',
    holderSessionId: stored?.holderSessionId ?? null,
    holderTitle: stored?.holderTitle ?? null,
    viewers: stored?.viewers ?? 0,
    reportedAt,
    clearRequestedAt: row.browserClearRequestedAt?.toISOString() ?? null,
    profileClearedAt: stored?.profileClearedAt ?? null,
    savedLogins: stored?.savedLogins ?? null,
  };
}

const NOT_YOURS = 'No managed runner of yours has this id';

/** The longest page a browser_open may ask for. */
export const BROWSER_OPEN_URL_MAX = 2048;

/** The page a browser_open asks for: absent, or an http(s) URL of at most BROWSER_OPEN_URL_MAX characters, else 400. */
export function browserOpenUrl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new BadRequestException('url must be a string');
  const trimmed = raw.trim();
  if (trimmed.length > BROWSER_OPEN_URL_MAX) throw new BadRequestException(`url is longer than ${BROWSER_OPEN_URL_MAX} characters`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException('url is not an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('url must be an http or https address');
  }
  return parsed.toString();
}

/** The browser's tab of its own on this server (web lib/runnerBrowser.ts runnerBrowserTabPath), absolute. */
export function browserTabUrl(runnerId: string, env: NodeJS.ProcessEnv = process.env): string {
  const origin = (env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/u, '');
  return `${origin}/runners/${uuidToBase62(runnerId)}/browser`;
}

@Injectable()
export class ManagedRunnerBrowserService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /** The caller's own managed runner by the id in the path, or 404. */
  private async ownManagedRunner(ownerId: string, rawId: string) {
    let id: string;
    try {
      id = toUuid(rawId);
    } catch {
      throw new NotFoundException(NOT_YOURS);
    }
    const managed = await this.prisma.managedRunner.findFirst({ where: { runnerId: id, ownerId }, select: { id: true } });
    if (!managed) throw new NotFoundException(NOT_YOURS);
    const runner = await this.prisma.runner.findFirst({
      where: { id, ownerId },
      select: { id: true, capabilities: true, browserState: true, browserClearRequestedAt: true },
    });
    if (!runner) throw new NotFoundException(NOT_YOURS);
    return runner;
  }

  async state(ownerId: string, rawId: string): Promise<RunnerBrowserState> {
    const runner = await this.ownManagedRunner(ownerId, rawId);
    return browserStateOf(rawId, runner);
  }

  /**
   * browser_status (`GET /runner/browser`): the account's own Orbit Cloud runner's browser, found by the account rather
   * than by an id, since an account has at most one. No managed runner: `runnerId` null and state UNKNOWN.
   */
  async accountStatus(ownerId: string): Promise<RunnerBrowserStatus> {
    const managed = await this.prisma.managedRunner.findUnique({ where: { ownerId }, select: { runnerId: true } });
    const runner = managed
      ? await this.prisma.runner.findFirst({
        where: { id: managed.runnerId, ownerId },
        select: { browserState: true, browserClearRequestedAt: true },
      })
      : null;
    const state = runner ? browserStateOf(managed!.runnerId, runner) : null;
    return {
      enabled: true,
      runnerId: state?.runnerId ?? null,
      state: state?.state ?? 'UNKNOWN',
      running: state?.state === 'RUNNING',
      holderSessionId: state?.holderSessionId ?? null,
      holderTitle: state?.holderTitle ?? null,
      viewers: state?.viewers ?? 0,
      savedLogins: state?.savedLogins ?? null,
      reportedAt: state?.reportedAt ?? null,
    };
  }

  /**
   * browser_open (`POST /runner/browser/open`): start the account's Orbit Cloud browser if it is not running and, with a
   * url, open that page in it; answer the browser's tab on this server. sessionId is the asking session (a uuid), whose
   * own lease a page may be opened under, and no other's: while another session holds the browser, a url is refused
   * rather than taken from it. Carried by the runner's next heartbeat, which it is woken for at once, like the clear.
   */
  async open(ownerId: string, sessionId: string, rawUrl: unknown): Promise<RunnerBrowserOpenResponse> {
    const url = browserOpenUrl(rawUrl);
    const managed = await this.prisma.managedRunner.findUnique({ where: { ownerId }, select: { runnerId: true } });
    const runner = managed
      ? await this.prisma.runner.findFirst({
        where: { id: managed.runnerId, ownerId },
        select: { id: true, capabilities: true, browserState: true },
      })
      : null;
    if (!runner) throw new ConflictException('This account has no Orbit Cloud runner, so there is no browser to open');
    if (!runner.capabilities.includes(BROWSER_OPEN_V1)) {
      throw new ConflictException('The Orbit Cloud runner is too old to open its browser for a session: it does not declare browser-open/v1');
    }
    const holder = storedBrowserState(runner.browserState, new Date(0))?.holderSessionId;
    if (url && holder && holder !== uuidToBase62(sessionId) && holder !== sessionId) {
      throw new ConflictException(`The browser is in use by session ${holder}; try again after it finishes, or open it without a url to watch`);
    }
    const requestedAt = new Date();
    await this.prisma.runner.update({
      where: { id: runner.id },
      data: { browserOpenRequestedAt: requestedAt, browserOpenRequest: url ? { sessionId, url } : { sessionId } },
    });
    this.realtime?.notifyRunnerWake(runner.id);
    return { runnerId: runner.id, tabUrl: browserTabUrl(runner.id), url: url ?? null, requestedAt: requestedAt.toISOString() };
  }

  /**
   * Use the runner's browser: the sign-in this runner is waiting on its link is to be finished in the runner's browser.
   * Only for a runner that declares login-runner-browser/v1 (409 otherwise), and only while a sign-in waits on its link
   * (409 otherwise). Bound to that attempt: a sign-in started since is not the one asked about.
   */
  async signIn(ownerId: string, rawId: string): Promise<RunnerLoginState> {
    const runner = await this.ownManagedRunner(ownerId, rawId);
    if (!runner.capabilities.includes(LOGIN_RUNNER_BROWSER_V1)) {
      throw new ConflictException('This runner is too old to open a sign-in in its browser: it does not declare login-runner-browser/v1');
    }
    const login = await this.prisma.runner.findUniqueOrThrow({ where: { id: runner.id }, select: { loginStatus: true, loginAt: true } });
    const waiting = login.loginStatus === 'awaiting_code' || login.loginStatus === 'awaiting_approval';
    const { count } = waiting && login.loginAt
      ? await this.prisma.runner.updateMany({
        where: { id: runner.id, loginStatus: login.loginStatus, loginAt: login.loginAt },
        data: { loginBrowser: 'requested' },
      })
      : { count: 0 };
    if (count === 0) throw new ConflictException('No sign-in on this runner is waiting on its link');
    this.realtime?.notifyRunnerWake(runner.id);
    return loginStateOf(await this.prisma.runner.findUniqueOrThrow({ where: { id: runner.id } }));
  }

  /**
   * `beforeRequest` runs once the clear is known to be deliverable and before it is requested: browser_clear_logins
   * spends the owner's card there (runner-api/runner-browser-clear-approval.ts), and a refusal from it requests nothing.
   */
  async clear(ownerId: string, rawId: string, beforeRequest?: () => Promise<unknown>): Promise<RunnerBrowserClearResponse> {
    const runner = await this.ownManagedRunner(ownerId, rawId);
    if (!runner.capabilities.includes(BROWSER_CLEAR_V1)) {
      throw new ConflictException('This runner is too old to clear saved logins: it does not declare browser-clear/v1');
    }
    await beforeRequest?.();
    const requestedAt = new Date();
    await this.prisma.runner.update({ where: { id: runner.id }, data: { browserClearRequestedAt: requestedAt } });
    this.realtime?.notifyRunnerWake(runner.id);
    return { requestedAt: requestedAt.toISOString() };
  }
}

@UseGuards(ManagedRunnerBrowserEnabledGuard, JwtAuthGuard)
@Controller('runners/:id/browser')
export class ManagedRunnerBrowserController {
  constructor(private readonly browser: ManagedRunnerBrowserService) {}

  @PatScope('runners:read', { workspaceConfinable: false })
  @Get()
  state(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RunnerBrowserState> {
    return this.browser.state(user.userId, id);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Post('sign-in')
  @HttpCode(202)
  signIn(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RunnerLoginState> {
    return this.browser.signIn(user.userId, id);
  }

  @PatForbidden('RUNNER_CONTROL')
  @Post('clear')
  @HttpCode(202)
  clear(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RunnerBrowserClearResponse> {
    return this.browser.clear(user.userId, id);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [ManagedRunnerBrowserController],
  providers: [ManagedRunnerBrowserService, ManagedRunnerBrowserEnabledGuard],
  // The runner's door (runner-api/runner-browser.controller.ts) reads through the same service and guard.
  exports: [ManagedRunnerBrowserService, ManagedRunnerBrowserEnabledGuard],
})
export class ManagedRunnerBrowserModule {}
