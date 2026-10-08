import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { WikiRolloutGuard } from './wiki-rollout';
import { WikiSystemModelReads } from './wiki-system-model';

/**
 * The deployment's System model, on the user door (contract `systemModel.read`): its name and its state, for the
 * wiki settings page and the health line. Not a space's: any account the wiki is on for reads the same model, and
 * nothing in it names where the model answers or the key it is called with. Beside it, the executor switch as it
 * stands for the caller (`executor`, P9): the mode, and whether the server executes this account's wiki.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiSystemModelController {
  constructor(private readonly systemModel: WikiSystemModelReads) {}

  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('system-model')
  read(@CurrentUser() user: AuthUser) {
    return this.systemModel.readFor(user.userId);
  }
}
