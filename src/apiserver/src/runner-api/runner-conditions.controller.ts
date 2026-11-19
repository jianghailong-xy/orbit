/**
 * The door behind a session's `condition_get` (docs/condition-triggers-design.md §8, runner-go condition_tools.go): a
 * condition's state, its newest samples and its events, read for the runner's owner. There is no create, change or
 * delete here: a condition is proposed only on a task's startWhen or a schedule's WHEN rule, on the owner's card.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { ConditionView } from '@orbit/shared';
import type { Runner } from '@prisma/client';

import { PublicIdPipe } from '../common/public-id';
import { ConditionsService } from '../conditions/conditions.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerConditionsController {
  constructor(private readonly conditions: ConditionsService) {}

  @Get('conditions/:id')
  get(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string): Promise<ConditionView> {
    return this.conditions.get(runner.ownerId, id);
  }
}
