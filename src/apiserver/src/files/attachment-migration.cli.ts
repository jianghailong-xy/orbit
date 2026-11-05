/**
 * Moving old attachments out of Postgres, from a shell (attachment-migration.ts; docs/self-hosting.md, "Moving old
 * attachments out of Postgres"), against DATABASE_URL and the deployment's ORBIT_FILES_* settings. In Compose that is
 * the apiserver's container, which has both and the files directory:
 *
 *   docker compose exec apiserver node src/apiserver/dist/files/attachment-migration.cli.js status
 *       where the bytes of every attachment are; writes nothing
 *   docker compose exec apiserver node src/apiserver/dist/files/attachment-migration.cli.js clear
 *       ONE-WAY: clears `data` on every copied row whose bytes are read back from the file store
 *
 * `clear` prints a line for each row it refuses, and can be stopped at any point and run again. It exits 0 when no
 * attachment has bytes in Postgres any more, and 1 when any still does.
 */
import { databaseUrl, prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { AttachmentMigration, type AttachmentCounts, type RowsAndBytes } from './attachment-migration';
import { FilesService } from './files.service';

const USAGE = 'usage: attachment-migration.cli.js status|clear\n';

const say = (line: string) => process.stdout.write(`${line}\n`);
const amount = ({ rows, bytes }: RowsAndBytes) => `${rows} (${bytes} bytes)`;

function sayCounts(counts: AttachmentCounts): void {
  say(`attachments waiting for the copy: ${amount(counts.waiting)}`);
  say(`attachments copied and still in Postgres: ${amount(counts.copied)}`);
  say(`attachments only in the file store: ${amount(counts.storeOnly)}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'status' && command !== 'clear') {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const prisma = prismaClientFor(databaseUrl());
  try {
    const log = { log: say, warn: say };
    const migration = new AttachmentMigration(prisma, new FilesService(prisma as PrismaService), log);
    if (command === 'status') {
      sayCounts(await migration.counts());
      return;
    }
    const { cleared, refused, stopped } = await migration.clear((row) => say(`refused ${row.id} (sha256 ${row.sha256}): ${row.reason}`));
    if (stopped) say(`stopped: ${stopped}`);
    say(`cleared this run: ${amount(cleared)}, refused: ${refused}`);
    const counts = await migration.counts();
    sayCounts(counts);
    if (counts.waiting.rows > 0 || counts.copied.rows > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`attachment-migration: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
