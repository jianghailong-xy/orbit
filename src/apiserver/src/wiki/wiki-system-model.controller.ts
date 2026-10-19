import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { WikiRolloutGuard } from './wiki-rollout';
import { WikiSystemModelReads } from './wiki-system-model';

/**
 * The deployment's System model, on the user door (contract `systemModel.read`): its name and its state, for the
 * wiki settings page and the health line. Not a space's: any account the wiki is on for reads the same model, and
 * nothing in it names where the model answers or the key it is called with. Beside it, who executes the caller's
 * wiki (`executor`, P9): the server, for every account since P11 (contract `jobs.executor.read`).
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiSystemModelController {
  constructor(private readonly systemModel: WikiSystemModelReads) {}

  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('system-model')
  read() {
    return this.systemModel.readForUser();
  }
}
