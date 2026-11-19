import {
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
import { BROWSER_CLEAR_V1, toUuid, type RunnerBrowserClearResponse, type RunnerBrowserReport, type RunnerBrowserState } from '@orbit/shared';

import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MANAGED_RUNNER_BROWSER_GATE, type ManagedRunnerBrowserGate } from './managed-runner-browser-gate';

/**
 * The managed runner browser's state and Clear saved logins (docs/runner-browser-design.md §5, §6; P4 = the runner's
 * owner only):
 *
 *   GET  /api/runners/:id/browser         whether Chrome is running, the session holding the lease, open viewers,
 *                                         as the runner's last heartbeat reported them (RunnerBrowserState)
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
  };
}

const NOT_YOURS = 'No managed runner of yours has this id';

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

  async clear(ownerId: string, rawId: string): Promise<RunnerBrowserClearResponse> {
    const runner = await this.ownManagedRunner(ownerId, rawId);
    if (!runner.capabilities.includes(BROWSER_CLEAR_V1)) {
      throw new ConflictException('This runner is too old to clear saved logins: it does not declare browser-clear/v1');
    }
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
})
export class ManagedRunnerBrowserModule {}
