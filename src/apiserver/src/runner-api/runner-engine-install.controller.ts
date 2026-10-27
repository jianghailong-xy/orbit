import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Runner } from '@prisma/client';
import type { RunnerInstallState } from '@orbit/shared';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { RequestEngineInstallDto } from '../runners/dto';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import { RunnersService } from '../runners/runners.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

/**
 * An engine CLI installed on one of the account's runners, or the CLIs there updated, at an in-session
 * agent's request (`orbit runner install`, the `runner_engine_install` MCP tool), and that runner's engine
 * relay read back (`orbit runner install-status`, `runner_engine_install_status`).
 *
 * The web's Install and Update engines, through the same RunnersService calls: the request parks on the
 * runner row, the runner's next heartbeat hands it over (drainInstallRequest), and the runner runs that
 * engine's own recommended installer, or its engine update pass, and reports back through
 * /runner/install-result. The body names a known engine and a mode, never a command. As a press of
 * Install is, the request is the consent for that engine on that machine, so the runner does not consult
 * the AutoInstallEngines it was registered with — which is the boundary this door draws: an agent in a
 * session allowed to orchestrate can install a known engine CLI on any runner of its account.
 *
 * Gated as the runner list is (runner-runners.controller.ts): the calling session (X-Orbit-Session-Id)
 * must be allowed to orchestrate, and only the account's own runners are found — anyone else's is
 * answered as an id that names nothing. The status is the web's (GET /runners/:id/install).
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerEngineInstallController {
  private readonly logger = new Logger(RunnerEngineInstallController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runners: RunnersService,
    private readonly orchestration: RunnerOrchestrationAuthorizer,
  ) {}

  @Post('runners/:id/engine-install')
  async requestEngineInstall(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RequestEngineInstallDto,
  ): Promise<RunnerInstallState> {
    const session = await this.orchestration.assert(runner, sessionId, orchestrationToken);
    const update = dto.mode === 'update';
    const target = await this.prisma.runner.findFirst({
      where: { id, ownerId: runner.ownerId },
      select: { status: true, ...RUNNER_BEATS },
    });
    if (!target) throw new NotFoundException('runner not found');
    // Online as the web runner list and runner_list read it, which is when the web offers Install at all:
    // a machine that went quiet without signing off still reads ONLINE, and no heartbeat would come for it.
    if (!runnerIsOnline(target)) {
      throw new BadRequestException(`Runner is offline — it can only ${update ? 'update' : 'install'} while connected`);
    }
    const state = update
      ? await this.runners.startEngineUpdate(runner.ownerId, id)
      : await this.runners.startInstall(runner.ownerId, id, dto.engine);
    // Who asked: the runner row keeps what is running, not who started it.
    this.logger.log(
      update
        ? `session ${session} (runner ${runner.id}) asked runner ${id} to update its engine CLIs (named ${dto.engine})`
        : `session ${session} (runner ${runner.id}) asked runner ${id} to install ${dto.engine}`,
    );
    return state;
  }

  @Get('runners/:id/engine-install')
  async engineInstallState(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Param('id', PublicIdPipe) id: string,
  ): Promise<RunnerInstallState> {
    await this.orchestration.assert(runner, sessionId, orchestrationToken);
    return this.runners.getInstallState(runner.ownerId, id);
  }
}
