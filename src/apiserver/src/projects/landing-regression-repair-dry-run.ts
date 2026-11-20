import { Prisma } from '@prisma/client';

import { databaseUrl, prismaClientFor } from '../prisma/prisma-client';
import { predictLandingRegressionRepair, repairLine } from './landing-regression-repair';

/**
 * What the next start of the API server will do to rows §12.15 P-M1's first reading misread, read from the
 * database named by DATABASE_URL and written nowhere (`predictLandingRegressionRepair`). Everything is read
 * in one REPEATABLE READ, READ ONLY transaction, so a read-only role is enough and nothing can be written
 * even by mistake.
 *
 *   DATABASE_URL=postgresql://reader@host/db node dist/projects/landing-regression-repair-dry-run.js [--json]
 *
 * Prints one line per project, the same line the start logs for it, then a summary; `--json` prints the
 * whole prediction instead. Exit 0 whatever it finds; 1 when it could not read.
 */
async function main(): Promise<void> {
  const prisma = prismaClientFor(databaseUrl());
  try {
    const prediction = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      return predictLandingRegressionRepair(tx);
    }, { timeout: 15 * 60_000, maxWait: 60_000 });
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(prediction, null, 2)}\n`);
      return;
    }
    for (const project of prediction.projects) {
      const line = repairLine(project, true);
      if (line) process.stdout.write(`${line}\n`);
    }
    const toDone = prediction.projects.filter((project) => project.statusBefore === 'OPEN' && project.statusAfter === 'DONE');
    const items = prediction.projects.reduce((sum, project) => sum + project.supersededItemIds.length, 0);
    process.stdout.write(`prediction: ${prediction.projects.length} project(s) hold misread tasks; `
      + `${toDone.length} go OPEN -> DONE (${toDone.map((project) => project.projectId).join(', ') || 'none'}); `
      + `${items} open item(s) will be superseded; the deploy-time pass would freeze `
      + `${prediction.passWouldFreeze.length} identit${prediction.passWouldFreeze.length === 1 ? 'y' : 'ies'} first`
      + `${prediction.passWouldFreeze.length > 0 ? ` (${prediction.passWouldFreeze.join(', ')}), which this does not follow` : ''}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`dry run failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
