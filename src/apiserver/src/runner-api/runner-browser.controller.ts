import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid, type RunnerBrowserClearLoginsResponse, type RunnerBrowserOpenRequest, type RunnerBrowserOpenResponse, type RunnerBrowserStatus } from '@orbit/shared';

import { ManagedRunnerBrowserEnabledGuard, ManagedRunnerBrowserService } from '../managed-runners/browser-state';
import { PrismaService } from '../prisma/prisma.service';
import { PublicIdPipe } from '../common/public-id';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { accountBrowserRunner, claimBrowserClearApproval } from './runner-browser-clear-approval';

/**
 * browser_status and browser_open, and `orbit browser status` and `orbit browser open [--url]`
 * (docs/mocks/runner-browser/03-agent-tools.html ②): the account's Orbit Cloud browser, read and opened by any session
 * of the account (Q3 = A) through its runner's credential.
 *
 *   GET  /runner/browser        whether the browser is running, the session holding the lease, how many viewers are
 *                               connected and whether saved logins exist (never which sites): RunnerBrowserStatus
 *   POST /runner/browser/open   start the browser if it is not running and, with `url`, open that page in it; answers
 *                               the browser's tab on this server (RunnerBrowserOpenResponse). 409 while another
 *                               session holds the browser and a url is asked for, or when the account has no Orbit
 *                               Cloud runner or it is too old; 400 for a url that is not http(s)
 *
 *   - Behind the browser switch: off, 404 before anything else, as for a path the apiserver does not have.
 *   - The asking session is X-Orbit-Session-Id, and must be one of the runner's owner that this runner hosts: another
 *     account's session is refused 403 (P4 = A). What is read is the runner owner's own managed runner, found by the
 *     account, so no request can name another account's.
 *   - Reads through ManagedRunnerBrowserService, the service behind GET /runners/:id/browser.
 *
 * browser_clear_logins and `orbit browser clear-logins` (②), for any session of the account, only after the owner's yes:
 *
 *   POST /runner/browser/clear   { approvalId }: the clear POST /runners/:id/browser/clear makes (the runner's next
 *                                heartbeat is handed clearBrowserProfile; it stops Chrome and deletes the profile), for
 *                                the account's Orbit Cloud runner, against the card the asking session filed and a person
 *                                ALLOWED, spent by this clear (runner-browser-clear-approval.ts). Any other card — declined,
 *                                expired, already used, another session's — is 403, and nothing is sent to the runner.
 */
@UseGuards(ManagedRunnerBrowserEnabledGuard, RunnerAuthGuard)
@Controller('runner/browser')
export class RunnerBrowserController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly browser: ManagedRunnerBrowserService,
  ) {}

  @Get()
  async status(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
  ): Promise<RunnerBrowserStatus> {
    await this.callingSession(runner, sessionHeader);
    return this.browser.accountStatus(runner.ownerId);
  }

  @Post('clear')
  @HttpCode(202)
  async clear(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
    @Body(PublicIdPipe.forFields('approvalId')) body: { approvalId?: string } | undefined,
  ): Promise<RunnerBrowserClearLoginsResponse> {
    const sessionId = await this.callingSession(runner, sessionHeader);
    const target = await accountBrowserRunner(this.prisma, runner.ownerId);
    let approvalId = '';
    const { requestedAt } = await this.browser.clear(runner.ownerId, target.id, async () => {
      approvalId = await claimBrowserClearApproval(this.prisma, sessionId, body?.approvalId, target.id);
    });
    return { runnerId: target.id, approvalId, requestedAt };
  }

  @Post('open')
  @HttpCode(202)
  async open(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionHeader: string | undefined,
    @Body() body: RunnerBrowserOpenRequest | undefined,
  ): Promise<RunnerBrowserOpenResponse> {
    const sessionId = await this.callingSession(runner, sessionHeader);
    return this.browser.open(runner.ownerId, sessionId, body?.url);
  }

  private async callingSession(runner: Pick<Runner, 'id' | 'ownerId'>, header: string | undefined): Promise<string> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException('missing session context: the browser tools are a session\'s, so this door needs X-Orbit-Session-Id');
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
}
