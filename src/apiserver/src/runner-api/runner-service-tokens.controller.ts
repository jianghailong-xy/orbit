import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Base62UuidPipe } from '../common/base62-uuid.pipe';
import { Runner } from '@prisma/client';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { ServiceTokenAuthorizer } from './service-token.authorizer';

/**
 * `orbit token mint | list | revoke` — the narrow credentials a headless process runs on.
 *
 * Guarded by RunnerAuthGuard, so minting takes the MACHINE's credential and a service token can
 * never mint another: a leaked bridge token cannot renew itself past its TTL or widen its scope,
 * and revoking one never means re-registering the machine.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner/service-tokens')
export class RunnerServiceTokensController {
  constructor(private readonly serviceTokens: ServiceTokenAuthorizer) {}

  @Post()
  mint(
    @CurrentRunner() runner: Runner,
    @Body() dto: { scopes?: string[]; agentId?: string; label?: string; ttlSeconds?: number },
  ) {
    return this.serviceTokens.mint(runner, dto ?? {});
  }

  @Get()
  list(@CurrentRunner() runner: Runner) {
    return this.serviceTokens.list(runner);
  }

  @Delete(':id')
  revoke(@CurrentRunner() runner: Runner, @Param('id', Base62UuidPipe) id: string) {
    return this.serviceTokens.revoke(runner, id);
  }
}
