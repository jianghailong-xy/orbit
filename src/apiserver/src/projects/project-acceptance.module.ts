import { Module } from '@nestjs/common';

import { SessionsModule } from '../sessions/sessions.module';
import { ProjectAcceptanceService } from './project-acceptance.service';

/**
 * The shared, timer-free project criterion evaluator. Both Task evidence producers and both
 * project API doors must resolve this one instance; providing it in their larger modules would
 * create evaluators that can observe different in-process work.
 *
 * SessionsModule is imported, never re-provided, for the one conversation starting a project
 * tells (`project-started.ts`).
 */
@Module({
  imports: [SessionsModule],
  providers: [ProjectAcceptanceService],
  exports: [ProjectAcceptanceService],
})
export class ProjectAcceptanceModule {}
