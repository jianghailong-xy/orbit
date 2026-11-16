import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { CreateModelProviderDto, UpdateModelProviderDto } from '../providers/dto';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { ProvidersService } from '../providers/providers.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { workspaceProviderView } from './workspace-providers';

/**
 * The provider slugs an agent may pass as `provider`, read by `orbit provider list` and the
 * `provider_list` MCP tool. Tenant scope is the runner's owner, exactly as the task routes have it.
 *
 * Deliberately NOT behind the orchestration gate the agent routes use: `provider` is a field of
 * task_create and task_update, which every agent reaches, so gating discovery would leave the
 * agents that can set a provider unable to find out which ones exist. It is also a read of the
 * caller's own configuration, and a keyless one — no API key, no endpoint (ProvidersService.listUsable).
 *
 * The writes (`orbit provider create|update|delete`, provider_create/update/delete) reach the same
 * rows the web's /providers/mine doors do: the runner owner's personal providers, never a shared one.
 * They are keyed by the slug the list shows, and answer with the row as that page reads it — the key
 * only ever as `hasApiKey`. Asking the owner first is the runner's part: from inside a session each
 * of them puts a confirmation card in front of the owner before it gets here (askBeforeCreate).
 *
 * `?workspace=` (a workspace of the runner owner's, by name or id) answers instead which provider × engine
 * that workspace's runner can run, judged as SubAgent routing judges it (workspaceProviderView): what an
 * agent reads before delegating to that workspace or opening a session on it.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly prisma?: PrismaService,
    private readonly planUsage?: ProviderPlanUsageService,
  ) {}

  @Get('providers')
  list(@CurrentRunner() runner: Runner, @Query('workspace') workspace?: string) {
    if (workspace === undefined) return this.providers.listUsable(runner.ownerId);
    return workspaceProviderView(this.prisma!, { ownerId: runner.ownerId, workspace, planUsage: this.planUsage ?? null });
  }

  @Post('providers')
  create(@CurrentRunner() runner: Runner, @Body() dto: CreateModelProviderDto) {
    return this.providers.create(runner.ownerId, dto);
  }

  @Patch('providers/:slug')
  async update(@CurrentRunner() runner: Runner, @Param('slug') slug: string, @Body() dto: UpdateModelProviderDto) {
    return this.providers.update(runner.ownerId, await this.providers.idOfMine(runner.ownerId, slug), dto);
  }

  @Delete('providers/:slug')
  async remove(@CurrentRunner() runner: Runner, @Param('slug') slug: string) {
    return this.providers.remove(runner.ownerId, await this.providers.idOfMine(runner.ownerId, slug));
  }
}
