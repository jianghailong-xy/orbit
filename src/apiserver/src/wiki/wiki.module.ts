import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { WikiController } from './wiki.controller';
import { WikiArticles } from './wiki-articles';
import { WikiArticlesController } from './wiki-articles.controller';
import { WikiHealth } from './wiki-health';
import { WikiHealthController } from './wiki-health.controller';
import { WikiMaintenance } from './wiki-maintenance';
import { WikiMaintenanceTrigger } from './wiki-maintenance-run';
import { WikiRetrieval } from './wiki-retrieval';
import { WikiRunReads } from './wiki-run-reads';
import { WikiRunsController } from './wiki-runs.controller';
import { WikiService } from './wiki.service';

/**
 * The Orbit Wiki's own module.
 *
 * It provides two services, the one write entry point and the one retrieval read, and injects
 * nothing from Sessions, Projects or Tasks: the wiki is a knowledge store that reads their rows, and
 * a dependency on their services would make one object shared across two feature areas — which is
 * how a hand-built spec that stands the wiki up with a Prisma client alone would fail to construct
 * it. `RunnerApiModule` imports this module for `RunnerWikiController`, so the runner door and the
 * user door answer from one WikiService and one WikiRetrieval.
 */
@Module({
  // For the notifications the wiki sends — a space the spot checks sent back to Manual, and a
  // maintenance run that keeps failing: PushService is a sender with no feature state, not a Sessions
  // or Projects service.
  imports: [PushModule],
  // The articles' reads (contract `articles`), one run's read (contract `reviewModes.run`) and a
  // space's health (contract `maintenance.health`) are controllers of their own, so WikiController's
  // hand-built specs construct it as before.
  controllers: [WikiController, WikiArticlesController, WikiRunsController, WikiHealthController],
  // WikiMaintenance serves the maintenance run's dossiers and cursor (contract `maintenance`) to
  // `RunnerWikiMaintenanceController`, and reads the Sessions' and Projects' rows the way the other two
  // do: through Prisma, with no service of theirs. WikiArticles serves the articles to both doors the
  // same way (contract `articles`).
  // WikiMaintenanceTrigger makes a space's maintenance task when a committed fact finds it due (contract
  // `maintenance.job.trigger`): it takes the events this replica publishes as hints, through the global
  // RealtimeService, and reads and writes rows through Prisma alone.
  // WikiRunReads answers one run's page from the same rows, through Prisma alone, and WikiHealth the
  // Wiki home's status line.
  providers: [WikiService, WikiRetrieval, WikiMaintenance, WikiArticles, WikiMaintenanceTrigger, WikiRunReads, WikiHealth],
  exports: [WikiService, WikiRetrieval, WikiMaintenance, WikiArticles],
})
export class WikiModule {}
