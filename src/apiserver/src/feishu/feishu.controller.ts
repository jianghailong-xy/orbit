import { Body, Controller, Delete, Get, Patch, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { ChangeFeishuAppDto, ConnectFeishuAppDto } from './dto';
import { FeishuAppService } from './feishu-app.service';

/**
 * Settings → Integrations → Feishu (docs/feishu-bot-design.md §4.1, §10): the account's own Feishu (Lark) app.
 * The account itself, so no access token reaches it (ACCOUNT). The App Secret goes in and never comes back out:
 * every answer says only whether one is saved and whether it can still be decrypted.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('ACCOUNT')
@Controller('integrations/feishu')
export class FeishuController {
  constructor(private readonly apps: FeishuAppService) {}

  /** The administrators' switch, and the account's app (null while it has none). */
  @Get()
  read(@CurrentUser() user: AuthUser) {
    return this.apps.integration(user.userId);
  }

  /** Connect an app, or replace the one connected: saved only once Feishu traded the credentials for a token. */
  @Put()
  connect(@CurrentUser() user: AuthUser, @Body() dto: ConnectFeishuAppDto) {
    return this.apps.connect(user.userId, dto);
  }

  /** The app's own switch. */
  @Patch()
  change(@CurrentUser() user: AuthUser, @Body() dto: ChangeFeishuAppDto) {
    return this.apps.change(user.userId, dto);
  }

  /** Remove the app. */
  @Delete()
  remove(@CurrentUser() user: AuthUser) {
    return this.apps.remove(user.userId);
  }
}
