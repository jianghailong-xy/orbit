import { Module } from '@nestjs/common';

import { PushModule } from '../push/push.module';
import { CONDITION_NOTIFIER } from './condition-attention';
import { PushConditionNotifier } from './condition-notifier';
import { ConditionWorker } from './condition.worker';
import { ConditionsController } from './conditions.controller';
import { ConditionsService } from './conditions.service';

/**
 * Conditions (docs/condition-triggers-design.md): the service the heartbeat hands probes from and takes samples into,
 * the silence worker, and the owner's read. C3 and C4 import it and register their fire hooks on ConditionsService.
 */
@Module({
  imports: [PushModule],
  providers: [
    PushConditionNotifier,
    { provide: CONDITION_NOTIFIER, useExisting: PushConditionNotifier },
    ConditionsService,
    ConditionWorker,
  ],
  controllers: [ConditionsController],
  exports: [ConditionsService],
})
export class ConditionsModule {}
