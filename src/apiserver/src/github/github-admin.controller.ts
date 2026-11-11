import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { UpdateGithubAppDto } from './dto';
import { GithubAppConfigService } from './github-app-config.service';

/**
 * Admin → Integrations → GitHub App (docs/github-workspace-design.md §5.1): the App this deployment's
 * accounts connect GitHub through. Gated like the rest of the admin area. The client secret and the
 * private key go in and never come back out.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin/integrations/github')
export class GithubAdminController {
  constructor(private readonly config: GithubAppConfigService) {}

  @Get()
  settings() {
    return this.config.settings();
  }

  /** Saves the whole setting once GitHub's GET /app vouched for it. A secret or key left out stays. */
  @Put()
  update(@CurrentUser() admin: AuthUser, @Body() dto: UpdateGithubAppDto) {
    return this.config.update(admin.userId, dto);
  }
}
