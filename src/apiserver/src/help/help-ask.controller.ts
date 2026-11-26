import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { HelpAskAdminResult, HelpAskConversation, HelpAskCreateBody, HelpAskFollowUpBody, HelpAskList, HelpAskStuck } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { HelpAsk } from './help-ask';

/**
 * The help center's Ask, on the user door (docs/mocks/help-center board 02): asking, following up, reading an Ask, and
 * /help → Your questions. Answered by the server on its DeepSeek key (help-ask.ts). A personal access token asks with
 * sessions:write and reads with sessions:read, as it did when an Ask was a session; one confined to workspaces is
 * refused, as an Ask is in none.
 */
@UseGuards(JwtAuthGuard)
@Controller('help/ask')
export class HelpAskController {
  constructor(private readonly ask: HelpAsk) {}

  @PatScope('sessions:write', { workspaceConfinable: false })
  @Post()
  // Typed, and carrying no id: HelpAsk reads it by hand all the same, as a client may send anything.
  create(@CurrentUser() user: AuthUser, @Body() body: HelpAskCreateBody): Promise<{ id: string }> {
    return this.ask.create(user.userId, body);
  }

  @PatScope('sessions:read', { workspaceConfinable: false })
  @Get('conversations')
  list(@CurrentUser() user: AuthUser): Promise<HelpAskList> {
    return this.ask.list(user.userId);
  }

  @PatScope('sessions:read', { workspaceConfinable: false })
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<HelpAskConversation> {
    return this.ask.get(user.userId, id);
  }

  /** A follow-up question in the same Ask. */
  @PatScope('sessions:write', { workspaceConfinable: false })
  @Post(':id/messages')
  followUp(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() body: HelpAskFollowUpBody): Promise<HelpAskConversation> {
    return this.ask.followUp(user.userId, id, body);
  }

  /** Still stuck (board 02 ② right frame): who Ask your admin sends to, and what a GitHub report carries. */
  @PatScope('sessions:read', { workspaceConfinable: false })
  @Get(':id/stuck')
  stuck(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<HelpAskStuck> {
    return this.ask.stuck(user.userId, id);
  }

  /** Still stuck → Ask your admin: the conversation, as a task in an admin's own list. */
  @PatScope('sessions:write', { workspaceConfinable: false })
  @Post(':id/admin')
  askAdmin(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<HelpAskAdminResult> {
    return this.ask.askAdmin(user.userId, id);
  }
}
