import { Injectable, OnModuleInit } from '@nestjs/common';

import { ConditionsService } from '../conditions/conditions.service';
import { ScheduleRunsService } from './schedule-runs.service';

/**
 * A WHEN schedule's runs start from its condition (docs/condition-triggers-design.md §5.2): this registers the fire
 * hook ConditionsService calls in the transaction that fired, and ScheduleRunsService.fireCondition writes the run.
 */
@Injectable()
export class ScheduleConditionHook implements OnModuleInit {
  constructor(
    private readonly conditions: ConditionsService,
    private readonly runs: ScheduleRunsService,
  ) {}

  onModuleInit(): void {
    this.conditions.registerFireHook({
      onFired: async (tx, firing) => {
        if (firing.condition.scheduleId) await this.runs.fireCondition(tx, firing);
      },
    });
  }
}
