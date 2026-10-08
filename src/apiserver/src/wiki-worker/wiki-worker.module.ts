import { Module } from '@nestjs/common';
import { WIKI_PLAN_SERVER_JOB } from '@orbit/shared';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { WikiArticles } from '../wiki/wiki-articles';
import { WikiPlans } from '../wiki/wiki-plan';
import { WikiService } from '../wiki/wiki.service';
import { wikiArticlesJobRunner } from './wiki-articles-job';
import { wikiImportJobRunner } from './wiki-import-job';
import { wikiPlanDraftJobRunner } from './wiki-plan-draft-job';
import { WikiJobExecutor, WIKI_JOB_RUNNERS, WIKI_JOB_RUNNERS_TOKEN, type WikiJobRunner } from './wiki-job-executor';
import { WikiModelRequestChannel } from './wiki-model-notify';
import { WikiRepoOpChannel } from './wiki-repo-op-notify';
import { WikiRepoOps } from './wiki-repo-ops';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WIKI_SYSTEM_MODEL_CONFIG, WikiModelStatusProbe } from './wiki-model-status';
import { currentWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';
import { wikiVerifyJobRunner } from './wiki-verify-job';

/**
 * Everything the wiki-worker process runs (contract `systemModel.service`, `jobs` and `modelQueue`): the
 * database and the worker's own providers, with no AppModule, no controller and nothing that listens. The
 * System model's configuration is read from this process's environment once, here — the only process whose
 * environment has it. Four things run on top of it, in this order of dependence:
 *
 *   WikiModelStatusProbe      probes the model and writes `wiki_model_status` (probe on /health, state, heartbeat)
 *   WikiModelRequestQueue     runs the request queue: claim, call, write back, settle (design §5.2)
 *   WikiService, WikiArticles the wiki's own reads and writes, for the pipelines that run as jobs (design §4.2)
 *   WikiJobExecutor           claims jobs and runs them, their calls going through the queue (design §5.1)
 *
 * WikiRepoOpChannel is here for the other half of that same wait (design §7): a job that needs the
 * repository writes a `wiki_repo_op` (WikiRepoOps) and waits on it, and the channel is how it hears the
 * answer land. The apiserver dispatches and settles those rows (runner-api/wiki-repo-op-relay.ts); the
 * worker only writes and waits.
 *
 * ORBIT_WIKI_EXECUTOR decides who they run for (wiki-executor-switch.ts): under the default `runner` they
 * claim nothing, and the worker only probes — exactly what it did before this phase.
 *
 * THE PIPELINES WRITE THROUGH THE WIKI'S OWN SERVICES, not through their own queries (design §4.2): an import
 * proposes through WikiService, the same one writer the runner door's `imports` route calls, with origin
 * import; the `articles` job reads the plan and a topic's input and writes its articles through WikiArticles,
 * exactly as the runner door does, and asks for the space's snapshot through WikiRepoOps; a verify job reads
 * the verification list and records verdicts through WikiService, exactly as the runner door does, against the
 * same evidence reader and the same one writer of a verdict; a plan job reads the plan and stores its draft
 * through WikiPlans, the gate the runner door's drafts go through. The worker holds no realtime hub and no push
 * service — the services' own defaults are none — so what a job records is not announced to a connected client
 * by this process; realtime is an accelerant and never the truth (contract `realtime.correctness`). What the
 * pipelines' own kinds are is decided here too: the job kind map the executor claims by is built with those
 * services and the System model's name in it.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: WIKI_SYSTEM_MODEL_CONFIG, useFactory: currentWikiSystemModel },
    { provide: WikiService, useFactory: (prisma: PrismaService) => new WikiService(prisma), inject: [PrismaService] },
    { provide: WikiArticles, useFactory: (prisma: PrismaService) => new WikiArticles(prisma), inject: [PrismaService] },
    { provide: WikiPlans, useFactory: (prisma: PrismaService) => new WikiPlans(prisma), inject: [PrismaService] },
    WikiRepoOps,
    {
      provide: WIKI_JOB_RUNNERS_TOKEN,
      useFactory: (
        prisma: PrismaService,
        wiki: WikiService,
        repoOps: WikiRepoOps,
        model: WikiSystemModelConfig,
        repoWake: WikiRepoOpChannel,
        articles: WikiArticles,
        plans: WikiPlans,
      ): Record<string, WikiJobRunner> => {
        const plan = wikiPlanDraftJobRunner({ prisma, plans, repoOps, model: model.model, repoWake });
        return {
          ...WIKI_JOB_RUNNERS,
          import: wikiImportJobRunner({ prisma, wiki, repoOps, model: model.model, repoWake }),
          articles: wikiArticlesJobRunner({ prisma, articles, repoOps, repoWake, model: model.model ?? '' }),
          verify: wikiVerifyJobRunner(wiki, model.model),
          [WIKI_PLAN_SERVER_JOB.kinds.draft]: plan,
          [WIKI_PLAN_SERVER_JOB.kinds.revise]: plan,
        };
      },
      inject: [PrismaService, WikiService, WikiRepoOps, WIKI_SYSTEM_MODEL_CONFIG, WikiRepoOpChannel, WikiArticles, WikiPlans],
    },
    WikiModelStatusProbe,
    WikiModelRequestChannel,
    WikiRepoOpChannel,
    WikiModelRequestQueue,
    WikiJobExecutor,
  ],
})
export class WikiWorkerModule {}
