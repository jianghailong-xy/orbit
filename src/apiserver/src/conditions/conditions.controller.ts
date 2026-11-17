import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { ConditionView } from '@orbit/shared';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { ConditionsService } from './conditions.service';

/**
 * The owner's read of one condition (docs/condition-triggers-design.md §8 condition_get): its state, its newest samples
 * and its events. There is no create, change or delete here: a condition exists only on a task or a schedule.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class ConditionsController {
  constructor(private readonly conditions: ConditionsService) {}

  @Get('conditions/:id')
  @PatScope('sessions:read', { workspaceConfinable: false })
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<ConditionView> {
    return this.conditions.get(user.userId, id);
  }
}
