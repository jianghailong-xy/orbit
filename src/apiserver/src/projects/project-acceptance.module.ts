import { Module } from '@nestjs/common';

import { ProjectAcceptanceService } from './project-acceptance.service';

/**
 * The shared, timer-free project criterion evaluator. Both Task evidence producers and both
 * project API doors must resolve this one instance; providing it in their larger modules would
 * create evaluators that can observe different in-process work.
 */
@Module({
  providers: [ProjectAcceptanceService],
  exports: [ProjectAcceptanceService],
})
export class ProjectAcceptanceModule {}
