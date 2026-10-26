import { Body, Controller, HttpCode, Optional, Post, UseGuards } from '@nestjs/common';

import { MachineProtocol } from '../common/machine-protocol';
import { PrismaService } from '../prisma/prisma.service';
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
 * Read-only, and answered alike over HTTPS for the caller's own sessions, with the process named in the body: a runner
 * learns nothing from it about anything but its own sessions. Machine protocol, so that the link serves it (raw UUIDs,
 * like every other route the gateway calls).
 */
@MachineProtocol()
@UseGuards(RunnerAuthGuard)
@Controller('runner/link')
export class RunnerLinkWelcomeController {
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
    const sessions = await readRunnerLinkSessionStates(this.prisma, runner.id, leaseOwner, welcomeSessionIds(body));
    const release = this.releases?.assignedTo(runner.id);
    return { sessions, ...(release ? { release } : {}) };
  }
}
