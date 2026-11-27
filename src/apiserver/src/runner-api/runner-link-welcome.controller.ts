import { Body, Controller, HttpCode, Inject, Logger, Optional, Post, UseGuards } from '@nestjs/common';

import { MachineProtocol } from '../common/machine-protocol';
import {
  MANAGED_RUNNER_BROWSER_GATE,
  MANAGED_RUNNER_BROWSER_OFF,
  type ManagedRunnerBrowserGate,
} from '../managed-runners/managed-runner-browser-gate';
import type { ManagedRunnerInstance } from '../managed-runners/managed-runner-instance';
import { PrismaService } from '../prisma/prisma.service';
import { recordRunnerLinkOpened } from '../runners/runner-presence';
import { CurrentManagedRunnerInstance, CurrentRunner } from './current-runner.decorator';
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
 * how the reaper knows of a mass disconnection its runners are back from — unless the connection is a renewal: opened
 * with a token minted moments ago by a process still heard. The same write records the process as heard now
 * (`last_heard_at`): a Welcome is the one call presence counts besides the heartbeat (docs/runner-link-design.md
 * §15.16). One that fails is logged and costs the answer nothing.
 *
 * `browser` is whether the runner is offered the managed runner browser (docs/runner-browser-design.md §2): true only
 * with the browser switch on and the runner a managed one whose instance the runner guard authorized against the
 * manager's record (generation and Pod UID). A self-managed runner is never offered it.
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
    /** Absent in the specs that build this controller by hand: the browser is off. */
    @Optional() @Inject(MANAGED_RUNNER_BROWSER_GATE) private readonly browserGate: ManagedRunnerBrowserGate = MANAGED_RUNNER_BROWSER_OFF,
  ) {}

  @Post('welcome')
  @HttpCode(200)
  async welcome(
    @CurrentRunner() runner: { id: string },
    @Body() body: RunnerLinkWelcomeRequest,
    @CurrentRunnerLink() link?: RunnerLinkContext,
    @CurrentManagedRunnerInstance() managedInstance?: ManagedRunnerInstance,
  ): Promise<RunnerLinkWelcomeAnswer> {
    const leaseOwner = parseLeaseGeneration(link ? link.leaseOwner : body?.leaseOwner, 'leaseOwner');
    const sessionIds = welcomeSessionIds(body);
    // Before Welcome, and so before the new connection's first beat moves the runner's last one on.
    if (link) {
      await recordRunnerLinkOpened(this.prisma, runner.id, link).catch((error: unknown) =>
        this.log.warn(`runner ${runner.id}: its last beat before this connection was not kept: ${(error as Error).message}`));
    }
    const sessions = await readRunnerLinkSessionStates(this.prisma, runner.id, leaseOwner, sessionIds);
    const release = this.releases?.assignedTo(runner.id);
    const browser = this.browserGate.enabled && managedInstance !== undefined;
    return { sessions, ...(release ? { release } : {}), browser };
  }
}
