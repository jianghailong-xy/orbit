import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { WikiService } from '../wiki/wiki.service';
import { WikiJobExecutor, WIKI_JOB_RUNNERS, WIKI_JOB_RUNNERS_TOKEN, type WikiJobRunner } from './wiki-job-executor';
import { WikiModelRequestChannel } from './wiki-model-notify';
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
 *   WikiService               the wiki's own reads and writes, for the pipelines that run as jobs (design §4.2)
 *   WikiJobExecutor           claims jobs and runs them, their calls going through the queue (design §5.1)
 *
 * ORBIT_WIKI_EXECUTOR decides who they run for (wiki-executor-switch.ts): under the default `runner` they
 * claim nothing, and the worker only probes — exactly what it did before this phase.
 *
 * THE PIPELINES WRITE THROUGH WikiService, not through their own queries (design §4.2): a job reads the
 * verification list and records verdicts exactly as the runner door does, against the same evidence reader
 * and the same one writer of a verdict. The worker holds no realtime hub and no push service — the service's
 * two default to none — so a verdict a job records is not announced to a connected client by this process;
 * realtime is an accelerant and never the truth (contract `realtime.correctness`), and the apiserver is the
 * one holding the client's stream. What the pipelines' own kinds are is decided here too: the job kind map
 * the executor claims by is built with the wiki service and the System model's name in it.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: WIKI_SYSTEM_MODEL_CONFIG, useFactory: currentWikiSystemModel },
    { provide: WikiService, useFactory: (prisma: PrismaService) => new WikiService(prisma), inject: [PrismaService] },
    {
      provide: WIKI_JOB_RUNNERS_TOKEN,
      useFactory: (wiki: WikiService, model: WikiSystemModelConfig): Record<string, WikiJobRunner> => ({
        ...WIKI_JOB_RUNNERS,
        verify: wikiVerifyJobRunner(wiki, model.model),
      }),
      inject: [WikiService, WIKI_SYSTEM_MODEL_CONFIG],
    },
    WikiModelStatusProbe,
    WikiModelRequestChannel,
    WikiModelRequestQueue,
    WikiJobExecutor,
  ],
})
export class WikiWorkerModule {}
