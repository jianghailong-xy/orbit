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

test('migration gives pre-existing rows a non-null HUMAN_SIGNOFF compatibility value', () => {
  const sql = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0179_task_completion_criterion', 'migration.sql',
  ), 'utf8');
  const statements = sql.replace(/^--.*$/gm, '');
  assert.match(sql, /ADD COLUMN "completion_criterion"[\s\S]*NOT NULL DEFAULT 'HUMAN_SIGNOFF'/);
  assert.doesNotMatch(statements, /UPDATE\s+"?task"?/i, 'the constant-default migration must not rewrite rows');
  assert.doesNotMatch(statements, /status/i, 'adding a criterion must not migrate task status');
});

suite('stored tasks expose one of the three criteria and omission reads HUMAN_SIGNOFF', async (t) => {
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
  assert.equal(storedWithoutDeclaration.completionCriterion, 'HUMAN_SIGNOFF');

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
    title: 'human', completionCriterion: 'HUMAN_SIGNOFF',
  });
  assert.deepEqual(
    [executable, verification, human].map((task) => task.completionCriterion),
    ['EXECUTABLE', 'VERIFICATION', 'HUMAN_SIGNOFF'],
  );
  assert.ok(
    [storedWithoutDeclaration, executable, verification, human]
      .every((task) => task.status === TaskStatus.OPEN),
    'declaring or defaulting a criterion must not write a completion status',
  );
});
