/**
 * The stored Task boundary for N1.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with migration 0179 applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this fixture never dispatches'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
    } as unknown as RealtimeService,
  );
}

// 0179's text is frozen history: it created the enum with the label spelled HUMAN_SIGNOFF, which
// migration 0224 later renamed IN PLACE. The claim here is about how the column arrived — a
// constant default, no row rewrite, no status write — and that is unchanged by a later rename.
test('migration gives pre-existing rows a non-null compatibility value without rewriting them',
  () => {
  const sql = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0179_task_completion_criterion', 'migration.sql',
  ), 'utf8');
  const statements = sql.replace(/^--.*$/gm, '');
  assert.match(sql, /ADD COLUMN "completion_criterion"[\s\S]*NOT NULL DEFAULT 'HUMAN_SIGNOFF'/);
  assert.doesNotMatch(statements, /UPDATE\s+"?task"?/i, 'the constant-default migration must not rewrite rows');
  assert.doesNotMatch(statements, /status/i, 'adding a criterion must not migrate task status');
  // And 0224's rename kept that property: it names the type, never the table.
  const rename = readFileSync(join(
    process.cwd(), 'prisma', 'migrations',
    '0224_evidence_judgment_removal_of_human_signoff', 'migration.sql',
  ), 'utf8').replace(/^--.*$/gm, '');
  assert.match(rename,
    /ALTER TYPE "task_completion_criterion" RENAME VALUE 'HUMAN_SIGNOFF' TO 'EVIDENCE_JUDGMENT'/);
  assert.doesNotMatch(rename, /UPDATE\s+"?task"?\s+SET/i);
});

suite('stored tasks expose one of the three criteria and omission reads EVIDENCE_JUDGMENT', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`TRUNCATE "task", "user" RESTART IDENTITY CASCADE`);

  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${ownerId}@n1.invalid`, name: 'n1', passwordHash: 'x' },
  });
  const storedWithoutDeclaration = await db.task.create({
    data: {
      ownerId, title: 'stored before clients knew the field',
      creatorType: 'USER', creatorId: ownerId,
    },
  });
  assert.equal(storedWithoutDeclaration.completionCriterion, 'EVIDENCE_JUDGMENT');

  const service = tasksService(db);
  const executable = await service.create(ownerId, {
    title: 'executable', completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  });
  const verification = await service.create(ownerId, {
    title: 'verification', completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
  });
  const human = await service.create(ownerId, {
    title: 'human', completionCriterion: 'EVIDENCE_JUDGMENT',
  });
  assert.deepEqual(
    [executable, verification, human].map((task) => task.completionCriterion),
    ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT'],
  );
  assert.ok(
    [storedWithoutDeclaration, executable, verification, human]
      .every((task) => task.status === TaskStatus.OPEN),
    'declaring or defaulting a criterion must not write a completion status',
  );
});
