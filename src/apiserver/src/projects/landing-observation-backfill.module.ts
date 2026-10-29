import { Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { databaseUrl } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { runLandingObservationBackfill } from './landing-observation-backfill';
import { ProjectOpenItemService } from './project-open-item.service';

/**
 * Runs revision 29's deploy-time pass (`landing-observation-backfill.ts`, §10.9 「迁移」 2) once per start
 * of the API server, after `prisma migrate deploy` and before the server takes a request: Nest awaits
 * this hook before it listens, so a replica that has just started answers no J9 question about work the
 * pass has yet to give an identity. A second replica starting beside it waits on the pass's lock and
 * then finds nothing left. No interval: the pass is idempotent, and a start is when it runs.
 *
 * It never fails a start. A task the pass has not reached reads as it did before revision 29 — DONE and
 * not yet landed — so a run that failed is logged and runs again on the next start.
 *
 * Imported by AppModule only: the Wiki worker shares the database and must not run it too.
 */
@Injectable()
export class LandingObservationBackfillAtBoot implements OnApplicationBootstrap {
  private readonly log = new Logger('LandingObservationBackfill');

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await runLandingObservationBackfill(this.prisma, { databaseUrl: databaseUrl(), log: this.log });
      // O-T1's item for an identity nobody can name in an AGENT_PUSH project (`settleDeliveredIdentity`)
      // is delivered after its commit, as every other door delivers it.
      const unknown = result.projects.flatMap((project) => project.left
        .filter((task) => task.settlement === 'IDENTITY_UNKNOWN')
        .map((task) => task.taskId));
      if (unknown.length > 0) await this.openItems()?.deliverForTasks(unknown);
    } catch (error) {
      this.log.error(
        `the landing backfill did not finish and runs again on the next start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The open-item delivery, resolved when it is needed: this module imports no feature module. */
  private openItems(): ProjectOpenItemService | undefined {
    try {
      return this.moduleRef.get(ProjectOpenItemService, { strict: false });
    } catch {
      return undefined;
    }
  }
}

@Module({ providers: [LandingObservationBackfillAtBoot] })
export class LandingObservationBackfillModule {}
