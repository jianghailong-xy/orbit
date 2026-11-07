import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { SetFeishuAdminDto } from './dto';
import { FeishuAppService } from './feishu-app.service';

/**
 * The admin area's side of Feishu bots (docs/feishu-bot-design.md §4.1, §10): Admin → Integrations → Feishu's one
 * switch, "Allow accounts to connect Feishu bots", with how many apps accounts connected, and removing an account's
 * app from Admin → Users. Gated like the user-management area: a signed-in ADMIN, never an access token.
 */
@UseGuards(JwtAuthGuard, AdminRoleGuard)
@PatForbidden('ADMIN')
@Controller('admin')
export class FeishuAdminController {
  constructor(private readonly apps: FeishuAppService) {}

  @Get('integrations/feishu')
  settings() {
    return this.apps.adminSettings();
  }

  /** Switch it; answered with what GET answers. */
  @Put('integrations/feishu')
  setAllowed(@CurrentUser() admin: AuthUser, @Body() dto: SetFeishuAdminDto) {
    return this.apps.setAllowed(admin.userId, dto.allowed);
  }

  /** Remove an account's app. */
  @Delete('users/:id/feishu')
  removeApp(@CurrentUser() admin: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.apps.removeByAdmin(admin.userId, id);
  }
}
