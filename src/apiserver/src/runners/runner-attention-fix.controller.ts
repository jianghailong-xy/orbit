import { BadRequestException, Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import type { RunnerAttentionFixRequest } from '@orbit/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { isAttentionFixKind } from './attention-fix';
import { RunnerAttentionFixService } from './runner-attention-fix.service';

@UseGuards(JwtAuthGuard)
@Controller('runners')
export class RunnerAttentionFixController {
  constructor(private readonly fixes: RunnerAttentionFixService) {}

  // Fix with an agent: start a session on this machine, in its most recently used workspace, whose first
  // message is this warning's facts. Owner-scoped like the runner's other controls: it runs an agent there.
  @PatForbidden('RUNNER_CONTROL')
  @Post(':id/attention/:kind/fix')
  fix(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('kind') kind: string,
    @Body() body: RunnerAttentionFixRequest | undefined,
  ) {
    if (!isAttentionFixKind(kind)) throw new BadRequestException('Unknown warning');
    return this.fixes.fix(user.userId, id, kind, body);
  }
}
