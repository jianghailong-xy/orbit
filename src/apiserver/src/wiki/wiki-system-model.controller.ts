import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { WikiRolloutGuard } from './wiki-rollout';
import { WikiSystemModelReads } from './wiki-system-model';

/**
 * The deployment's System model, on the user door (contract `systemModel.read`): its name and its state, for the
 * wiki settings page and the health line. Not a space's: any account the wiki is on for reads the same answer, and
 * nothing in it names where the model answers or the key it is called with.
 */
@UseGuards(JwtAuthGuard, WikiRolloutGuard)
@Controller('wiki')
export class WikiSystemModelController {
  constructor(private readonly systemModel: WikiSystemModelReads) {}

  @PatScope('wiki:read', { workspaceConfinable: false })
  @Get('system-model')
  read() {
    return this.systemModel.read();
  }
}
