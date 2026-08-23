import { Module } from '@nestjs/common';

import { ProjectOwnershipRefileService } from './project-ownership-refile.service';

/**
 * Unit L6's repair, in a module of its own, for `ProjectHandoffModule`'s reason: the endpoint that
 * offers it hangs off a TASK, and importing all of `ProjectsModule` into `TasksModule` would drag
 * every coordinator service and its timers along for one dependency.
 *
 * `PrismaModule` is @Global, so this needs no imports of its own.
 */
@Module({
  providers: [ProjectOwnershipRefileService],
  exports: [ProjectOwnershipRefileService],
})
export class ProjectOwnershipModule {}
