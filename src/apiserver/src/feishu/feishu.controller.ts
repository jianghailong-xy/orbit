import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { ChangeFeishuAppDto, ConnectFeishuAppDto } from './dto';
import { FeishuAppService } from './feishu-app.service';
import { FeishuOwnerService } from './feishu-owner.service';

/**
 * Settings → Integrations → Feishu (docs/feishu-bot-design.md §4.1, §10): the account's own Feishu (Lark) app.
 * The account itself, so no access token reaches it (ACCOUNT). The App Secret goes in and never comes back out:
 * every answer says only whether one is saved and whether it can still be decrypted.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('ACCOUNT')
@Controller('integrations/feishu')
export class FeishuController {
  constructor(
    private readonly apps: FeishuAppService,
    private readonly owner: FeishuOwnerService,
  ) {}

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

  /** The app's own switch, and how much its alert cards carry. */
  @Patch()
  change(@CurrentUser() user: AuthUser, @Body() dto: ChangeFeishuAppDto) {
    return this.apps.change(user.userId, dto);
  }

  /** Remove the app. */
  @Delete()
  remove(@CurrentUser() user: AuthUser) {
    return this.apps.remove(user.userId);
  }

  /** A one-time code that makes whoever sends it to the bot in a direct message the app's owner (§5.1). */
  @Post('connect-codes')
  connectCode(@CurrentUser() user: AuthUser) {
    return this.owner.createCode(user.userId);
  }

  /** Nobody is the owner any more: alerts stop, and the app stays connected (§5.2). */
  @Delete('owner')
  disconnectOwner(@CurrentUser() user: AuthUser) {
    return this.owner.disconnect(user.userId);
  }

  /** One test message to the owner; 409 while there is none. */
  @Post('test')
  @HttpCode(200)
  sendTest(@CurrentUser() user: AuthUser) {
    return this.owner.sendTest(user.userId);
  }
}
