import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentMigration } from './attachment-migration';
import { FilesService } from './files.service';

/**
 * The automatic half of moving old attachments out of Postgres (attachment-migration.ts). A start asks once whether any
 * row waits, and with none there is nothing more: no timer, and nothing for the rows written after this. With some, the copy runs behind the server, which does not wait for it, and ends when it has reached them
 * all. A process that stops partway leaves its rows as they are, for the next start to carry on from.
 *
 * It never fails a start: a row not copied is read from `data`, as it always was.
 *
 * In FilesModule, which only the API server loads: the Wiki worker shares the database and does not run this.
 */
@Injectable()
export class AttachmentCopyAtBoot implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('AttachmentCopy');
  private readonly stopping = new AbortController();
  private copying?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const migration = new AttachmentMigration(this.prisma, this.files, this.log);
      if (await migration.copyIsDue()) {
        this.copying = migration.copy(this.stopping.signal);
      }
    } catch (error) {
      this.log.error(`the copy of old attachments did not start, and is asked for again on the next start: ${String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping.abort();
    await this.copying;
  }
}
