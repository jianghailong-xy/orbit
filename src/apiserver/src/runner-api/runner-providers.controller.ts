import { Controller, Get, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { ProvidersService } from '../providers/providers.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * The provider slugs an agent may pass as `provider`, read by `orbit provider list` and the
 * `provider_list` MCP tool. Tenant scope is the runner's owner, exactly as the task routes have it.
 *
 * Deliberately NOT behind the orchestration gate the agent routes use: `provider` is a field of
 * task_create and task_update, which every agent reaches, so gating discovery would leave the
 * agents that can set a provider unable to find out which ones exist. It is also a read of the
 * caller's own configuration, and a keyless one — no API key, no endpoint (ProvidersService.listUsable).
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get('providers')
  list(@CurrentRunner() runner: Runner) {
    return this.providers.listUsable(runner.ownerId);
  }
}
