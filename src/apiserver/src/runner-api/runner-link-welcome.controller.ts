import { Body, Controller, HttpCode, Logger, Optional, Post, UseGuards } from '@nestjs/common';

import { MachineProtocol } from '../common/machine-protocol';
import { PrismaService } from '../prisma/prisma.service';
import { recordRunnerLinkOpened } from '../runners/runner-presence';
import { CurrentRunner } from './current-runner.decorator';
import { parseLeaseGeneration } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { CurrentRunnerLink, type RunnerLinkContext } from './runner-link-call';
import {
  readRunnerLinkSessionStates,
  welcomeSessionIds,
  type RunnerLinkWelcomeAnswer,
  type RunnerLinkWelcomeRequest,
} from './runner-link-welcome';
import { RunnerReleaseFeed } from './runner-release-feed';

/**
 * POST /api/runner/link/welcome: what the link gateway's Welcome says of the connecting process's sessions and of its
 * release (runner-link-welcome.ts). The gateway calls it for every connection it opens in MODE_LINK, before Welcome.
 *
 * Answered alike over HTTPS for the caller's own sessions, with the process named in the body: a runner learns nothing
 * from it about anything but its own sessions. Machine protocol, so that the link serves it (raw UUIDs, like every other
 * route the gateway calls). It reads, but for one write a link call makes: the gateway is opening a connection, so the
 * runner's last beat is kept as the last it was heard with before it connected again (recordRunnerLinkOpened), which is
 * how the reaper knows of a mass disconnection its runners are back from. That write is the same however often the
 * gateway asks again, and one that fails is logged and costs the answer nothing.
 */
@MachineProtocol()
@UseGuards(RunnerAuthGuard)
@Controller('runner/link')
export class RunnerLinkWelcomeController {
  private readonly log = new Logger('RunnerLinkWelcome');

  constructor(
    private readonly prisma: PrismaService,
    /** Absent in the specs that build this controller by hand: no release is stated. */
    @Optional() private readonly releases?: RunnerReleaseFeed,
  ) {}

  @Post('welcome')
  @HttpCode(200)
  async welcome(
    @CurrentRunner() runner: { id: string },
    @Body() body: RunnerLinkWelcomeRequest,
    @CurrentRunnerLink() link?: RunnerLinkContext,
  ): Promise<RunnerLinkWelcomeAnswer> {
    const leaseOwner = parseLeaseGeneration(link ? link.leaseOwner : body?.leaseOwner, 'leaseOwner');
    const sessionIds = welcomeSessionIds(body);
    // Before Welcome, and so before the new connection's first beat moves the runner's last one on.
    if (link) {
      await recordRunnerLinkOpened(this.prisma, runner.id).catch((error: unknown) =>
        this.log.warn(`runner ${runner.id}: its last beat before this connection was not kept: ${(error as Error).message}`));
    }
    const sessions = await readRunnerLinkSessionStates(this.prisma, runner.id, leaseOwner, sessionIds);
    const release = this.releases?.assignedTo(runner.id);
    return { sessions, ...(release ? { release } : {}) };
  }
}
