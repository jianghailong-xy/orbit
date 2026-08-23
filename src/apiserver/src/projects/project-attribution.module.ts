import { Module } from '@nestjs/common';

import { ProjectAttributionService } from './project-attribution.service';

/**
 * Unit L7's read service, in a module of its own, for the reason `ProjectHandoffModule` is: both
 * doors need it — a task's own page asks about one task, the project API asks about the project it
 * lands in — and importing all of `ProjectsModule` into `TasksModule` for one stateless reader
 * would drag every coordinator service and its timers along with it.
 *
 * `PrismaModule` is @Global, so this needs no imports of its own.
 */
@Module({
  providers: [ProjectAttributionService],
  exports: [ProjectAttributionService],
})
export class ProjectAttributionModule {}
