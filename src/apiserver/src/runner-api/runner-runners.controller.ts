import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { Prisma, Runner } from '@prisma/client';
import { usedRunnerEngines } from '../common/runner-engines';
import { runnerOs } from '../common/runner-platform';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline, runnerLastBeatAt } from '../runners/runner-presence';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

/** What a runner is read with here: the web list's fields this view shows, never its credential. */
const ORCHESTRATION_RUNNER_SELECT = {
  id: true,
  name: true,
  displayName: true,
  status: true,
  version: true,
  maxConcurrent: true,
  ...RUNNER_BEATS,
  // The OS its heartbeats name (common/runner-platform.ts) rides in here.
  capabilities: true,
  // usedRunnerEngines' inputs, so each engine reads signed in or not exactly as the web list shows it.
  engines: true,
  accountNames: true,
  accountPauses: true,
  defaultRemoved: true,
} as const satisfies Prisma.RunnerSelect;

type OrchestrationRunnerRecord = Prisma.RunnerGetPayload<{ select: typeof ORCHESTRATION_RUNNER_SELECT }> & {
  _count: { workspaces: number };
};

/**
 * The account's runners for in-session orchestrators, reached by `orbit runner list` and the
 * `runner_list` MCP tool with the machine's runner token: what agent_create and agent_update take as
 * `runnerId`. Without it a runner no workspace is bound to yet could not be found from a session at
 * all, and its id had to be copied out of the web page's address.
 *
 * Gated exactly as the workspace list is (runner-agents.controller.ts): the calling session
 * (X-Orbit-Session-Id) must be allowed to orchestrate. Tenant scope is the runner's owner. Every
 * runner of the account is listed, in the web runner list's order, and a managed runner among them as
 * that list shows it — a runner like the others, with no mark of its own.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerRunnersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
  ) {}

  @Get('runners')
  async listRunners(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
  ) {
    await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const runners = await this.prisma.runner.findMany({
      where: { ownerId: runner.ownerId },
      // The web runner list's order (RunnersService.runnerViews).
      orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { enrolledAt: 'asc' }, { id: 'asc' }],
      select: {
        ...ORCHESTRATION_RUNNER_SELECT,
        // The workspaces bound to it, counted as the workspace list lists them: the owner's, not deleted.
        _count: { select: { workspaces: { where: { ownerId: runner.ownerId, deletedAt: null } } } },
      },
    });
    const now = Date.now();
    return runners.map((record) => this.toOrchestrationView(record, now));
  }

  /**
   * Whitelisted, like the workspace list's view: no credential, key or environment reaches the model
   * invoking MCP. `online` is decided by the rule every reader uses (runners/runner-presence.ts), so it
   * answers as the web runner list does. `os` and `engines` are what the runner's heartbeats reported,
   * and are left out when it has reported none; `engines` holds the installed ones only.
   */
  private toOrchestrationView(runner: OrchestrationRunnerRecord, now: number) {
    const os = runnerOs(runner.capabilities);
    const engines = usedRunnerEngines(runner);
    return {
      id: runner.id,
      name: runner.name,
      displayName: runner.displayName,
      online: runnerIsOnline(runner, now),
      status: runner.status,
      version: runner.version,
      lastHeartbeatAt: runnerLastBeatAt(runner),
      maxConcurrent: runner.maxConcurrent,
      ...(os ? { os } : {}),
      ...(engines
        ? { engines: engines.filter((entry) => entry.installed).map(({ engine, auth }) => ({ engine, auth })) }
        : {}),
      workspaceCount: runner._count.workspaces,
    };
  }
}
