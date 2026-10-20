import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { CreateModelProviderDto, CursorKeyCheckDto, CursorKeyCheckResultDto, UpdateModelProviderDto } from '../providers/dto';
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
 *
 * The writes (`orbit provider create|update|delete`, provider_create/update/delete) reach the same
 * rows the web's /providers/mine doors do: the runner owner's personal providers, never a shared one.
 * They are keyed by the slug the list shows, and answer with the row as that page reads it — the key
 * only ever as `hasApiKey`. Asking the owner first is the runner's part: from inside a session each
 * of them puts a confirmation card in front of the owner before it gets here (askBeforeCreate).
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get('providers')
  list(@CurrentRunner() runner: Runner) {
    return this.providers.listUsable(runner.ownerId);
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

  /**
   * What Cursor CLI on this runner answered `agent models` with, asked with the Cursor API key the
   * session was dispatched on (docs/cursor-runtime-contract.md §9): the key's last check, which a
   * person sees on the key (ProvidersService.recordCursorKeyCheck). Only for a session of this runner's.
   */
  @Post('sessions/:id/cursor-key-check')
  @HttpCode(200)
  cursorKeyCheck(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) sessionId: string,
    @Body() dto: CursorKeyCheckDto,
  ) {
    return this.providers.recordCursorKeyCheck(runner.id, sessionId, dto, runner.ownerId);
  }

  /**
   * What Cursor CLI on this runner answered `agent models` with, asked with a Cursor key the runner was
   * handed on a heartbeat to check (`cursorKeyChecks`): settles the check somebody is waiting on — a key
   * being connected, or a saved one checked again (ProvidersService.answerCursorKeyCheck). Only a check
   * handed to this runner, about the key it was handed, and once: anything else is `accepted: false`.
   */
  @Post('cursor-key-check-result')
  @HttpCode(200)
  cursorKeyCheckResult(@CurrentRunner() runner: Runner, @Body() dto: CursorKeyCheckResultDto) {
    return this.providers.answerCursorKeyCheck(runner.id, dto);
  }
}
