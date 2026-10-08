import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { ManagedRunnerStatus } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden, PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { ManagedRunnerWriteDto } from './dto';
import { ManagedRunnerEnabledGuard } from './managed-runner-gate';
import { ManagedRunnerService } from './managed-runner.service';

/**
 * The authenticated owner's managed runner (docs/managed-runner-design.md, "Server and three client
 * interfaces"). The read is open whatever the switch says and reports `enabled`; every write is
 * behind JwtAuthGuard first and ManagedRunnerEnabledGuard second, so with the feature off it is
 * 401 to a stranger and 404 MANAGED_RUNNER_DISABLED to a signed-in owner, before anything is read
 * from its body or written. Accepted writes answer 202 with the mapping's status.
 */
@UseGuards(JwtAuthGuard)
@Controller('managed-runner')
export class ManagedRunnerController {
  constructor(private readonly managed: ManagedRunnerService) {}

  @PatScope('runners:read', { workspaceConfinable: false })
  @Get()
  status(@CurrentUser() user: AuthUser): Promise<ManagedRunnerStatus> {
    return this.managed.status(user.userId);
  }

  @PatForbidden('RUNNER_CONTROL')
  @UseGuards(ManagedRunnerEnabledGuard)
  @Post('ensure')
  @HttpCode(202)
  ensure(@CurrentUser() user: AuthUser, @Body() dto: ManagedRunnerWriteDto): Promise<ManagedRunnerStatus> {
    return this.managed.ensure(user.userId, dto.idempotencyKey);
  }

  @PatForbidden('RUNNER_CONTROL')
  @UseGuards(ManagedRunnerEnabledGuard)
  @Post('retry')
  @HttpCode(202)
  retry(@CurrentUser() user: AuthUser, @Body() dto: ManagedRunnerWriteDto): Promise<ManagedRunnerStatus> {
    return this.managed.retry(user.userId, dto.idempotencyKey, dto.revision);
  }

  @PatForbidden('RUNNER_CONTROL')
  @UseGuards(ManagedRunnerEnabledGuard)
  @Post('wake')
  @HttpCode(202)
  wake(@CurrentUser() user: AuthUser, @Body() _dto: ManagedRunnerWriteDto): Promise<never> {
    return this.managed.refuseUnsupported(user.userId, 'wake');
  }

  @PatForbidden('RUNNER_CONTROL')
  @UseGuards(ManagedRunnerEnabledGuard)
  @Post('sleep')
  @HttpCode(202)
  sleep(@CurrentUser() user: AuthUser, @Body() _dto: ManagedRunnerWriteDto): Promise<never> {
    return this.managed.refuseUnsupported(user.userId, 'sleep');
  }

  @PatForbidden('RUNNER_CONTROL')
  @UseGuards(ManagedRunnerEnabledGuard)
  @Post('delete')
  @HttpCode(202)
  delete(@CurrentUser() user: AuthUser, @Body() _dto: ManagedRunnerWriteDto): Promise<never> {
    return this.managed.refuseUnsupported(user.userId, 'delete');
  }
}
