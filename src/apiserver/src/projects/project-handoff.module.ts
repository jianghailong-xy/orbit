import { Module } from '@nestjs/common';

import { ProjectHandoffService } from './project-handoff.service';

/**
 * Unit L4's one service, in a module of its own.
 *
 * Both sides of a crossing need it — `TasksService` asks the question and spends the answer, the
 * project API is where a person answers it — and it must be ONE instance: two would be two ideas of
 * what an approval is, which is precisely the class of defect this unit exists to remove. A module
 * this small is the cheapest way to say that. Importing all of `ProjectsModule` into `TasksModule`
 * would work too, and would drag every coordinator service and its timers along with it for one
 * dependency (`TasksService` provided twice is how this deployment once ended up with two auto-run
 * reconcilers).
 *
 * `PrismaModule` is @Global, so this needs no imports of its own.
 */
@Module({
  providers: [ProjectHandoffService],
  exports: [ProjectHandoffService],
})
export class ProjectHandoffModule {}
