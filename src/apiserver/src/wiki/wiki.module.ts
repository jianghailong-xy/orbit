import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { AdminRoleGuard } from '../users/admin-role.guard';
import { WikiController } from './wiki.controller';
import { AdminWikiController } from './wiki-admin.controller';
import { WikiArticles } from './wiki-articles';
import { WikiArticlesController } from './wiki-articles.controller';
import { WikiChatDrafts } from './wiki-chat-drafts';
import { WikiDocs } from './wiki-docs';
import { WikiDocsController } from './wiki-docs.controller';
import { WikiHealth } from './wiki-health';
import { WikiHealthController } from './wiki-health.controller';
import { WikiJobReads } from './wiki-job-reads';
import { WikiJobsController } from './wiki-jobs.controller';
import { WikiMaintenance } from './wiki-maintenance';
import { WikiMaintenanceTrigger } from './wiki-maintenance-run';
import { WikiPlans } from './wiki-plan';
import { WikiPlanController } from './wiki-plan.controller';
import { WikiRetrieval } from './wiki-retrieval';
import { WikiRunReads } from './wiki-run-reads';
import { WikiRunsController } from './wiki-runs.controller';
import { WikiService } from './wiki.service';
import { WikiSystemModelReads } from './wiki-system-model';
import { WikiSystemModelController } from './wiki-system-model.controller';
import { WikiTrashPurge } from './wiki-trash';
import { WikiMaintenanceController } from './wiki-maintenance.controller';

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
  // The administrators' wiki routes (contract `plan.jobs.rebuild.support`) are a controller of their own, behind the
  // admin area's guard rather than the wiki's flag, which reads the caller's account.
  controllers: [WikiController, WikiArticlesController, WikiRunsController, WikiHealthController, WikiPlanController, WikiDocsController, WikiSystemModelController, WikiJobsController, WikiMaintenanceController, AdminWikiController],
  // WikiMaintenance serves the maintenance run's dossiers and cursor (contract `maintenance`) to the server's
  // maintenance job, and reads the Sessions' and Projects' rows the way the other two do: through Prisma,
  // with no service of theirs. WikiArticles serves the articles the same way (contract `articles`).
  // WikiMaintenanceTrigger makes a space's maintenance job when a committed fact finds it due (contract
  // `maintenance.job.trigger`): it takes the events this replica publishes as hints, through the global
  // RealtimeService, and reads and writes rows through Prisma alone.
  // WikiRunReads answers one run's page from the same rows, through Prisma alone, and WikiHealth the
  // Wiki home's status line. WikiPlans keeps the plan and its gate (contract `plan`), the same way, and
  // WikiDocs the documents written from it (contract `docs`).
  // WikiSystemModelReads reads the System model's name and state from the row the wiki-worker writes (contract
  // `systemModel.read`), through Prisma alone, for a controller of its own; WikiJobReads a space's server runs and
  // their calls (contract `jobs.read`) for Activity, the same way.
  // AdminRoleGuard depends only on the global PrismaService, so it is provided here too (UsersModule does not export
  // it), as ProvidersModule does for its admin controller.
  // WikiTrashPurge deletes for good, a batch at a time, the wikis whose time in Trash is up or whose owner asked for it
  // (contract `space.trash.purge`), on the process that runs the singleton sweeps, through Prisma alone.
  // WikiChatDrafts keeps a wiki chat's cards and the owner's presses (contract `chat.drafts`, `chat.presses`): it writes
  // through WikiService and WikiDocs, and the runner door and the chat's own module reach it through this module's export.
  providers: [WikiService, WikiRetrieval, WikiMaintenance, WikiArticles, WikiMaintenanceTrigger, WikiRunReads, WikiHealth, WikiPlans, WikiDocs, WikiSystemModelReads, WikiJobReads, WikiChatDrafts, WikiTrashPurge, AdminRoleGuard],
  exports: [WikiService, WikiRetrieval, WikiMaintenance, WikiArticles, WikiPlans, WikiDocs, WikiChatDrafts],
})
export class WikiModule {}
