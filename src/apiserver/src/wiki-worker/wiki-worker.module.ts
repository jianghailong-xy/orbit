import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WikiJobExecutor } from './wiki-job-executor';
import { WikiModelRequestChannel } from './wiki-model-notify';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WIKI_SYSTEM_MODEL_CONFIG, WikiModelStatusProbe } from './wiki-model-status';
import { currentWikiSystemModel } from './wiki-system-model';

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
 * ORBIT_WIKI_EXECUTOR decides who they run for (wiki-executor-switch.ts): under the default `runner` they
 * claim nothing, and the worker only probes — exactly what it did before this phase.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: WIKI_SYSTEM_MODEL_CONFIG, useFactory: currentWikiSystemModel },
    WikiModelStatusProbe,
    WikiModelRequestChannel,
    WikiModelRequestQueue,
    WikiJobExecutor,
  ],
})
export class WikiWorkerModule {}
