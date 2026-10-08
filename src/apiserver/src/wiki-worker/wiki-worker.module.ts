import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WIKI_SYSTEM_MODEL_CONFIG, WikiModelStatusProbe } from './wiki-model-status';
import { currentWikiSystemModel } from './wiki-system-model';

/**
 * Everything the wiki-worker process runs (contract `systemModel.service`): the database and the worker's own
 * providers, with no AppModule, no controller and nothing that listens. The System model's configuration is read
 * from this process's environment once, here — the only process whose environment has it.
 */
@Module({
  imports: [PrismaModule],
  providers: [{ provide: WIKI_SYSTEM_MODEL_CONFIG, useFactory: currentWikiSystemModel }, WikiModelStatusProbe],
})
export class WikiWorkerModule {}
