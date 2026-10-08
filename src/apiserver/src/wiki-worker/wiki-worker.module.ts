import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { WikiArticles } from '../wiki/wiki-articles';
import { wikiArticlesJobRunner } from './wiki-articles-job';
import { WikiJobExecutor, WIKI_JOB_RUNNERS, WIKI_JOB_RUNNERS_TOKEN, type WikiJobRunner } from './wiki-job-executor';
import { WikiModelRequestChannel } from './wiki-model-notify';
import { WikiRepoOpChannel } from './wiki-repo-op-notify';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WIKI_SYSTEM_MODEL_CONFIG, WikiModelStatusProbe } from './wiki-model-status';
import { WikiRepoOps } from './wiki-repo-ops';
import { currentWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';

/**
 * Everything the wiki-worker process runs (contract `systemModel.service`, `jobs` and `modelQueue`): the
 * database and the worker's own providers, with no AppModule, no controller and nothing that listens. The
 * System model's configuration is read from this process's environment once, here — the only process whose
 * environment has it. Three things run on top of it, in this order of dependence:
 *
 *   WikiModelStatusProbe      probes the model and writes `wiki_model_status` (probe on /health, state, heartbeat)
 *   WikiModelRequestQueue     runs the request queue: claim, call, write back, settle (design §5.2)
 *   WikiJobExecutor           claims jobs and runs them, their calls going through the queue (design §5.1)
 *
 * WikiRepoOpChannel is here for the other half of that same wait (design §7): a job that needs the
 * repository writes a `wiki_repo_op` and parks on it, and the channel is how it hears the answer land. The
 * apiserver dispatches and settles those rows (runner-api/wiki-repo-op-relay.ts); the worker only waits.
 *
 * THE PIPELINES WRITE THROUGH THE WIKI'S OWN SERVICES (design §4.2): the `articles` job reads the plan and a
 * topic's input and writes its articles through `WikiArticles`, exactly as the runner door does, and asks for
 * the space's snapshot through `WikiRepoOps`. The worker holds no realtime hub, so `WikiArticles` is built
 * without one: an article a job writes is not announced to a connected client by this process — realtime is
 * an accelerant and never the truth (contract `realtime.correctness`). The job kind map the executor claims by
 * is built here, with those services and the System model's name in it.
 *
 * ORBIT_WIKI_EXECUTOR decides who they run for (wiki-executor-switch.ts): under the default `runner` they
 * claim nothing, and the worker only probes — exactly what it did before this phase.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: WIKI_SYSTEM_MODEL_CONFIG, useFactory: currentWikiSystemModel },
    { provide: WikiArticles, useFactory: (prisma: PrismaService) => new WikiArticles(prisma), inject: [PrismaService] },
    WikiRepoOps,
    {
      provide: WIKI_JOB_RUNNERS_TOKEN,
      useFactory: (
        prisma: PrismaService,
        articles: WikiArticles,
        repoOps: WikiRepoOps,
        repoWake: WikiRepoOpChannel,
        model: WikiSystemModelConfig,
      ): Record<string, WikiJobRunner> => ({
        ...WIKI_JOB_RUNNERS,
        articles: wikiArticlesJobRunner({ prisma, articles, repoOps, repoWake, model: model.model ?? '' }),
      }),
      inject: [PrismaService, WikiArticles, WikiRepoOps, WikiRepoOpChannel, WIKI_SYSTEM_MODEL_CONFIG],
    },
    WikiModelStatusProbe,
    WikiModelRequestChannel,
    WikiRepoOpChannel,
    WikiModelRequestQueue,
    WikiJobExecutor,
  ],
})
export class WikiWorkerModule {}
