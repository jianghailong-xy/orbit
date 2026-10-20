import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { ManagedRunnerVolumeSwitchDto } from './dto';
import { ManagedRunnerEnabledGuard } from './managed-runner-gate';
import type { ManagedRunnerVolumeSwitchAnswer } from './managed-runner-volume-switch';
import { ManagedRunnerService } from './managed-runner.service';

/**
 * The administrator's side of managed runners: putting a restored data volume back under an account's runner
 * (managed-runner-volume-switch.ts; docs/managed-runner-kubernetes-operations.md, "Put a restored volume back under
 * its runner"). A signed-in ADMIN only, and no personal access token. The guards run in their order here: off, the
 * route is 401 to a stranger and then 404 MANAGED_RUNNER_DISABLED, before the role, the body or anything else is
 * read, as the owner's managed writes are; on, AdminRoleGuard refuses everybody but an administrator, by the role it
 * reads per request.
 */
@UseGuards(JwtAuthGuard, ManagedRunnerEnabledGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin/managed-runners')
export class ManagedRunnerAdminController {
  constructor(private readonly managed: ManagedRunnerService) {}

  /**
   * Switch the runner's data volume to the restored one now under its name, once the manager has verified it and
   * that the recorded one is no longer in use. 200 with what was switched; 409 with the check that refused it.
   */
  @Post(':id/volume-switch')
  @HttpCode(200)
  switchVolume(
    @CurrentUser() admin: AuthUser,
    @Param('id', PublicIdPipe) runnerId: string,
    @Body() dto: ManagedRunnerVolumeSwitchDto,
  ): Promise<ManagedRunnerVolumeSwitchAnswer> {
    return this.managed.switchVolume(admin.userId, runnerId, dto);
  }
}
