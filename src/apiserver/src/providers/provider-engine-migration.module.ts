import { Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { databaseUrl } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderEngineMigration } from './provider-engine-migration';

/**
 * Runs the provider/engine data migration (provider-engine-migration.ts) once per start of the API
 * server, after `prisma migrate deploy` and before the server takes a request: Nest awaits this hook
 * before it listens, so a replica that has just started serves nothing the migration has yet to fold.
 * A second replica starting beside it waits on the migration's lock and then finds it done.
 *
 * It never fails a start. Every read path accepts the rows the migration has not reached yet — a
 * `deepseek-harness` row reads as a DeepSeek key on DeepSeek Harness, an old OpenCode spelling as the key
 * on OpenCode — so a run that failed is logged and runs again on the next start.
 *
 * Imported by AppModule only: the Wiki worker shares the database and must not run it too.
 */
@Injectable()
export class ProviderEngineMigrationAtBoot implements OnApplicationBootstrap {
  private readonly log = new Logger('ProviderEngineMigration');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await new ProviderEngineMigration(this.prisma, { databaseUrl: databaseUrl(), log: this.log }).run();
    } catch (error) {
      this.log.error(
        `the provider/engine migration did not finish and runs again on the next start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

@Module({ providers: [ProviderEngineMigrationAtBoot] })
export class ProviderEngineMigrationModule {}
