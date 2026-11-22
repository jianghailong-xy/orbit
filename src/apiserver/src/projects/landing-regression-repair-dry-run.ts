import { Prisma } from '@prisma/client';

import { databaseUrl, prismaClientFor } from '../prisma/prisma-client';
import {
  predictLandingRegressionRepair,
  repairLine,
  repairSummary,
  type RegressionRepairPrediction,
} from './landing-regression-repair';

/**
 * What the next start of the API server will do to rows §12.15 P-M1's first reading misread, read from the
 * database named by DATABASE_URL and written nowhere (`predictLandingRegressionRepair`). Everything is read
 * in one REPEATABLE READ, READ ONLY transaction, so a read-only role is enough and nothing can be written
 * even by mistake.
 *
 *   DATABASE_URL=postgresql://reader@host/db node dist/projects/landing-regression-repair-dry-run.js [--json]
 *
 * Prints one line for every project of the footprint — its status as read from the row and the status the
 * start leaves it in, the line the start logs for a project it writes something about — then its
 * dependents and a summary that counts every project, the unchanged ones by status; `--json` prints the
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
    for (const project of prediction.projects) process.stdout.write(`${repairLine(project, true)}\n`);
    // The OPEN dependents of misread tasks, by project: which J9 holds today on them (and so the fix
    // releases), and what happens to them — at the start, or at the project's Resume when it is paused.
    const byProject = new Map<string, RegressionRepairPrediction['dependents']>();
    for (const dependent of prediction.dependents) {
      const key = dependent.projectId ?? 'no project';
      byProject.set(key, [...(byProject.get(key) ?? []), dependent]);
    }
    for (const [projectId, dependents] of byProject) {
      const released = dependents.filter((dependent) => dependent.heldTodayByJ9);
      const starting = released.filter((dependent) => dependent.autoRunWhenReady && !dependent.dispatchHold);
      const paused = dependents.some((dependent) => dependent.projectPaused);
      const since = released.map((dependent) => dependent.heldSince).filter((at): at is Date => at !== null)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
      process.stdout.write(`dependents (predicted): project ${projectId}: ${dependents.length} OPEN dependent(s) of misread tasks; `
        + `${released.length} held today by J9 on them${since ? ` (since ${new Date(since).toISOString()} at the earliest)` : ''} `
        + `and released by the fix; ${starting.length} of those start by themselves once their other prerequisites are met `
        + `${paused ? 'when the project is resumed (it is paused, so nothing starts at the deploy)' : 'at the next ready sweep after the start'}\n`);
    }
    process.stdout.write(`${repairSummary(prediction.projects, true)}; `
      + `${prediction.dependents.length} OPEN dependent(s) are released as far as these tasks go; `
      + `the deploy-time pass would freeze `
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
