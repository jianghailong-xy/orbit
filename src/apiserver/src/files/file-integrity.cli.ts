/**
 * `files orphans` and `files verify` (docs/drive-technical-design.md §10.3), from a shell against DATABASE_URL and
 * the deployment's ORBIT_DRIVE_* settings:
 *
 *   node src/apiserver/dist/files/file-integrity.cli.js orphans [--delete]
 *       lists objects in each store no file_blob row names, older than the grace period; --delete removes them
 *   node src/apiserver/dist/files/file-integrity.cli.js verify [--quick]
 *       every blob whose bytes should be stored: present, and (unless --quick) hashing to its sha256
 *
 * Exits 1 when verify finds a problem, 0 otherwise.
 */
import { databaseUrl, prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { FileIntegrity } from './file-integrity';
import { FilesService } from './files.service';

const say = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const [command, flag] = process.argv.slice(2);
  if ((command !== 'orphans' || (flag !== undefined && flag !== '--delete')) && (command !== 'verify' || (flag !== undefined && flag !== '--quick'))) {
    process.stderr.write('usage: file-integrity.cli.js orphans [--delete] | verify [--quick]\n');
    process.exitCode = 2;
    return;
  }
  const prisma = prismaClientFor(databaseUrl());
  try {
    const integrity = new FileIntegrity(prisma as PrismaService, new FilesService(prisma as PrismaService));
    if (command === 'orphans') {
      for (const r of await integrity.orphans({ remove: flag === '--delete' })) {
        say(`${r.storage}: ${r.scanned} object(s), ${r.orphans} orphan(s) older than the grace period (${r.orphanBytes} bytes), ${r.withinGrace} younger`);
        for (const sha256 of r.sample) say(`  ${sha256}`);
        say(flag === '--delete' ? `${r.storage}: removed ${r.removed} (${r.removedBytes} bytes)` : `${r.storage}: nothing removed (report only)`);
      }
      return;
    }
    const report = await integrity.verify({ deep: flag !== '--quick' });
    for (const p of report.problems) say(`${p.problem} ${p.sha256} (${p.storage}): ${p.driveVersions} drive version(s), ${p.attachments} attachment(s)`);
    say(`checked ${report.checked}, read back ${report.hashed}, problems ${report.problems.length}`);
    if (report.problems.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`file-integrity: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
