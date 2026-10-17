import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { WikiPlans } from './wiki-plan';

/**
 * The wiki in the administrators' area (contracts/wiki.contract.json `plan.jobs.rebuild.support`): asking for the
 * documents of an account's space again, for support, and the list of that account's spaces to pick one from. Gated
 * like the user-management area: a signed-in ADMIN, never an access token, nor while viewing Orbit as another account.
 *
 * Not behind WikiRolloutGuard: that guard reads the caller's own account, and the account acted on here is another
 * one — the build asks the wiki's flag for the space's owner instead (`WikiPlans.requestBuildForSupport`).
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin/wiki')
export class AdminWikiController {
  constructor(private readonly plans: WikiPlans) {}

  /** An account's spaces, with what picking one to build needs and nothing the space knows. */
  @Get('users/:id/spaces')
  spaces(@Param('id', PublicIdPipe) id: string) {
    return this.plans.supportSpaces(id);
  }

  /** The documents of a space's version in force asked for again, with why: recorded as this administrator's. */
  @Post('spaces/:id/plan/build')
  @HttpCode(HttpStatus.OK)
  build(@CurrentUser() admin: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() body: Record<string, unknown>) {
    return this.plans.requestBuildForSupport(admin.userId, id, body);
  }
}
