/**
 * The provider/engine data migration from a shell (docs/provider-engine-contract.md §7.6), against
 * DATABASE_URL and with the deployment's PROVIDER_SECRET_KEY, which decides a merge:
 *
 *   node src/apiserver/dist/providers/provider-engine-migration.cli.js --rehearse
 *       the whole run inside one transaction that is rolled back: the report, and nothing written —
 *       for a drill on a copy of production data
 *   node src/apiserver/dist/providers/provider-engine-migration.cli.js
 *       the run the API server makes when it starts
 *
 * Prints one JSON line per report line, then one with the summary. Exits 0 when the run finished, 1 when
 * it failed; a run that left rows for the next start (summary.complete false) still exits 0.
 */
import { Logger } from '@nestjs/common';
import { databaseUrl, prismaClientFor } from '../prisma/prisma-client';
import { ProviderEngineMigration } from './provider-engine-migration';

async function main(): Promise<void> {
  const rehearse = process.argv.includes('--rehearse');
  const url = databaseUrl();
  const prisma = prismaClientFor(url);
  try {
    // The lines go to stdout below; the logger keeps to errors, on stderr.
    const log = new Logger('ProviderEngineMigration');
    const quiet = { log: () => undefined, warn: () => undefined, error: (message: string) => log.error(message) };
    const migration = new ProviderEngineMigration(prisma, { databaseUrl: url, log: quiet });
    const result = rehearse ? await migration.rehearse() : await migration.run();
    for (const line of result.lines) process.stdout.write(`${JSON.stringify(line)}\n`);
    process.stdout.write(`${JSON.stringify({ runId: result.runId, rehearsal: result.rehearsal, summary: result.summary })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`provider-engine-migration: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
