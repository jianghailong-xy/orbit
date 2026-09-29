import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { WikiController } from './wiki.controller';
import { WikiArticles } from './wiki-articles';
import { WikiArticlesController } from './wiki-articles.controller';
import { WikiDocs } from './wiki-docs';
import { WikiDocsController } from './wiki-docs.controller';
import { WikiHealth } from './wiki-health';
import { WikiHealthController } from './wiki-health.controller';
import { WikiMaintenance } from './wiki-maintenance';
import { WikiMaintenanceTrigger } from './wiki-maintenance-run';
import { WikiPlanJobFacts } from './wiki-plan-job';
import { WikiPlans } from './wiki-plan';
import { WikiPlanController } from './wiki-plan.controller';
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
  // space's health (contract `maintenance.health`) and the plan (contract `plan`) are controllers of their
  // own, so WikiController's hand-built specs construct it as before — and so are the documents (contract `docs`).
  controllers: [WikiController, WikiArticlesController, WikiRunsController, WikiHealthController, WikiPlanController, WikiDocsController],
  // WikiMaintenance serves the maintenance run's dossiers and cursor (contract `maintenance`) to
  // `RunnerWikiMaintenanceController`, and reads the Sessions' and Projects' rows the way the other two
  // do: through Prisma, with no service of theirs. WikiArticles serves the articles to both doors the
  // same way (contract `articles`).
  // WikiMaintenanceTrigger makes a space's maintenance task when a committed fact finds it due (contract
  // `maintenance.job.trigger`): it takes the events this replica publishes as hints, through the global
  // RealtimeService, and reads and writes rows through Prisma alone.
  // WikiRunReads answers one run's page from the same rows, through Prisma alone, and WikiHealth the
  // Wiki home's status line. WikiPlans keeps the plan and its gate (contract `plan`) for both doors, the
  // same way, and WikiDocs the documents written from it (contract `docs`). WikiPlanJobFacts moves the
  // plan's jobs on when a task of the owner's changes (contract `plan.jobs.trigger`), from the same
  // published events as the maintenance trigger.
  providers: [WikiService, WikiRetrieval, WikiMaintenance, WikiArticles, WikiMaintenanceTrigger, WikiRunReads, WikiHealth, WikiPlans, WikiPlanJobFacts, WikiDocs],
  exports: [WikiService, WikiRetrieval, WikiMaintenance, WikiArticles, WikiPlans, WikiDocs],
})
export class WikiModule {}
