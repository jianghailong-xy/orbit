import { BadRequestException, Controller, ForbiddenException, Get, Headers, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { toUuid, type RunnerBrowserStatus } from '@orbit/shared';

import { ManagedRunnerBrowserEnabledGuard, ManagedRunnerBrowserService } from '../managed-runners/browser-state';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * browser_status and `orbit browser status` (docs/mocks/runner-browser/03-agent-tools.html ②): the account's Orbit
 * Cloud browser, read by any session of the account (Q3 = A) through its runner's credential.
 *
 *   GET /runner/browser   whether the browser is running, the session holding the lease, how many viewers are
 *                         connected and whether saved logins exist (never which sites): RunnerBrowserStatus
 *
 *   - Behind the browser switch: off, 404 before anything else, as for a path the apiserver does not have.
 *   - The asking session is X-Orbit-Session-Id, and must be one of the runner's owner that this runner hosts: another
 *     account's session is refused 403 (P4 = A). What is read is the runner owner's own managed runner, found by the
 *     account, so no request can name another account's.
 *   - Reads through ManagedRunnerBrowserService, the service behind GET /runners/:id/browser.
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
