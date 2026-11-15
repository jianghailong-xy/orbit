import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { HelpAskChoices, HelpAskList } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { HelpAsk } from './help-ask';

/**
 * The help center's Ask, on the user door (docs/mocks/help-center board 02): the Runs on picker, asking, and
 * /help → Your questions. A question's later messages are its session's own (`POST /api/sessions/:id/turns`), and it
 * is read, stopped and trashed as a session is. A personal access token asks with sessions:write and reads with
 * sessions:read, as it opens and lists sessions; one confined to workspaces is refused, as an Ask is in none.
 */
@UseGuards(JwtAuthGuard)
@Controller('help/ask')
export class HelpAskController {
  constructor(private readonly ask: HelpAsk) {}

  @PatScope('sessions:read', { workspaceConfinable: false })
  @Get('choices')
  choices(@CurrentUser() user: AuthUser): Promise<HelpAskChoices> {
    return this.ask.choices(user.userId);
  }

  @PatScope('sessions:write', { workspaceConfinable: false })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body(PublicIdPipe.forFields('runnerId')) body: unknown) {
    // The pipe hands a blank id through as it came; refused here, it never reaches a uuid column as "".
    const runnerId = (body as { runnerId?: unknown } | null)?.runnerId;
    if (typeof runnerId === 'string' && runnerId.trim() === '') {
      throw new BadRequestException('runnerId names the machine the question runs on');
    }
    return this.ask.create(user.userId, body, user.credential);
  }

  @PatScope('sessions:read', { workspaceConfinable: false })
  @Get('sessions')
  list(@CurrentUser() user: AuthUser): Promise<HelpAskList> {
    return this.ask.list(user.userId);
  }
}
