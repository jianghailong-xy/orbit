import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { ChangeFeishuAppDto, ChangeFeishuChatDto, ConfirmFeishuChatDto, ConnectFeishuAppDto } from './dto';
import { FeishuAppService } from './feishu-app.service';
import { FeishuChatRouteService } from './feishu-chat-route.service';
import { FeishuOwnerService } from './feishu-owner.service';

/**
 * Settings → Integrations → Feishu (docs/feishu-bot-design.md §4.1, §10): the account's own Feishu (Lark) app.
 * The account itself, so no access token reaches it (ACCOUNT). The App Secret goes in and never comes back out:
 * every answer says only whether one is saved and whether it can still be decrypted.
 *
 * The group routes (§8.1): reading them is the account's (ACCOUNT); connecting a group, changing and removing one are
 * the owner channel's (OWNER_INTERACTIVE, auth/pat-owner-channel-routes.ts), since they let people in a group start
 * agents on the account's machines.
 */
@UseGuards(JwtAuthGuard)
@PatForbidden('ACCOUNT')
@Controller('integrations/feishu')
export class FeishuController {
  constructor(
    private readonly apps: FeishuAppService,
    private readonly owner: FeishuOwnerService,
    private readonly chats: FeishuChatRouteService,
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

  /** The connected groups; with `ticket`, also the group that ticket would connect, while it works (§8.1). */
  @Get('chats')
  chatRoutes(@CurrentUser() user: AuthUser, @Query('ticket') ticket?: string) {
    return this.chats.list(user.userId, typeof ticket === 'string' && ticket !== '' ? ticket.slice(0, 128) : undefined);
  }

  /** Connect the group a ticket names with the owner's choices: once per ticket. */
  @Post('chats/confirm')
  @PatForbidden('OWNER_INTERACTIVE')
  confirmChat(@CurrentUser() user: AuthUser, @Body() dto: ConfirmFeishuChatDto) {
    return this.chats.confirm(user.userId, dto);
  }

  /** Switch a connected group off or on, or change what it was confirmed with. */
  @Patch('chats/:id')
  @PatForbidden('OWNER_INTERACTIVE')
  changeChat(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: ChangeFeishuChatDto) {
    return this.chats.change(user.userId, id, dto);
  }

  /** The group is no longer connected. */
  @Delete('chats/:id')
  @PatForbidden('OWNER_INTERACTIVE')
  removeChat(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.chats.remove(user.userId, id);
  }
}
