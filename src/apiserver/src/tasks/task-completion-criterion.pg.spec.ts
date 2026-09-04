/**
 * The stored Task boundary for N1.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable database accepted by the
 * coordinator PG safety guard, with migration 0179 applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerTasksController } from '../runner-api/runner-tasks.controller';
import {
  COMPLETION_CRITERION_REQUIRED_ACTION,
  COMPLETION_CRITERION_REQUIRED_CODE,
  requireExplicitCompletionCriterion,
} from './task-completion-criterion-gate';
import { TasksController } from './tasks.controller';
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

suite('stored tasks expose one of the three criteria, and the database supplies none', async (t) => {
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
  // 0179's compatibility value is still writable and still means exactly what it meant. What 0237
  // changed is that it has to be WRITTEN: this row states it rather than receiving it from a column
  // default, which is why the insert below still names the field it once could omit.
  const declaredHuman = await db.task.create({
    data: {
      ownerId, title: 'a criterion stated rather than defaulted',
      creatorType: 'USER', creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    },
  });
  assert.equal(declaredHuman.completionCriterion, 'EVIDENCE_JUDGMENT');

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
    [declaredHuman, executable, verification, human]
      .every((task) => task.status === TaskStatus.OPEN),
    'declaring a criterion must not write a completion status',
  );
});

/**
 * 0237: the same undeclared request, refused identically at both doors.
 *
 * This is the defect these three tests exist for. The runner door has always refused an omitted
 * `completionCriterion`; the JWT/user door read the same omission as the compatibility spelling of
 * EVIDENCE_JUDGMENT. One required field, two opposite contracts, chosen by which credential the
 * caller happened to hold — and the lenient answer was the expensive one, because EVIDENCE_JUDGMENT
 * has been declared-but-unimplemented since 2026-09-02, so a forgotten field did not produce a
 * relaxed task but one that nothing can ever complete.
 *
 * `deepEqual` on the whole body rather than field-by-field equality: the claim is that the two doors
 * answer with the same refusal, so any part of it that could differ is part of what is being tested.
 * Both are driven through their real controller methods, and both are checked to have refused
 * BEFORE the service — a door that refuses after writing has not refused.
 */
test('both write doors refuse an undeclared criterion with one identical refusal', async () => {
  let serviceCalls = 0;
  const tasks = {
    resolveAgentCreator: async () => { serviceCalls += 1; return undefined; },
    create: async () => { serviceCalls += 1; return { id: 'task-1' }; },
    createMany: async () => { serviceCalls += 1; return { tasks: [] }; },
    previewPlan: async () => { serviceCalls += 1; return {}; },
    previewCreateMany: async () => { serviceCalls += 1; return {}; },
  } as never;
  const userDoor = new TasksController(tasks, {} as never);
  const runnerDoor = new RunnerTasksController(tasks, {} as never, {} as never);
  const runner = { id: 'runner-1', ownerId: 'owner-1' } as never;

  const bodyOf = async (call: () => unknown): Promise<Record<string, unknown>> => {
    try {
      await call();
    } catch (error) {
      assert.ok(error instanceof BadRequestException, 'an undeclared criterion is a 400 REFUSAL');
      return error.getResponse() as Record<string, unknown>;
    }
    throw new assert.AssertionError({ message: 'the door accepted an undeclared criterion' });
  };

  // The same request, twice: nothing about it names a criterion, and nothing about it implies one.
  const undeclared = () => ({ title: 'work whose completion nobody declared' });
  const fromUser = await bodyOf(() => userDoor.create({ userId: 'owner-1' } as never, undeclared() as never));
  const fromRunner = await bodyOf(
    () => runnerDoor.createTask(runner, 'workspace-1', undefined, 'session-1', undeclared() as never),
  );
  assert.deepEqual(fromUser, fromRunner);
  assert.equal(fromUser.code, COMPLETION_CRITERION_REQUIRED_CODE);
  assert.equal(fromUser.requiredAction, COMPLETION_CRITERION_REQUIRED_ACTION);
  assert.equal(fromUser.kind, 'REFUSAL');
  assert.match(String(fromUser.message), /completionCriterion/);
  assert.match(String(fromUser.message), /never.*EVIDENCE_JUDGMENT/i);

  // And batch creation, where the refusal also has to say WHICH item was undeclared.
  const undeclaredBatch = () => ({ tasks: [{ title: 'one undeclared item' }] });
  const batchFromUser = await bodyOf(
    () => userDoor.batchCreate({ userId: 'owner-1' } as never, undeclaredBatch() as never),
  );
  const batchFromRunner = await bodyOf(
    () => runnerDoor.createTasks(runner, 'workspace-1', undefined, 'session-1', undeclaredBatch() as never),
  );
  assert.deepEqual(batchFromUser, batchFromRunner);
  assert.equal(batchFromUser.code, COMPLETION_CRITERION_REQUIRED_CODE);
  assert.equal(batchFromUser.itemIndex, 0);

  // A declaration one door translates unambiguously, the other must translate the same way, so the
  // parity above is not simply "both doors refuse everything".
  type Legacy = {
    title: string;
    acceptanceCommand: string;
    acceptanceExpectedExitCode: number;
    completionCriterion?: string;
  };
  const legacyExecutable: Legacy = {
    title: 'an N-1 executable declaration',
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
  };
  const userTranslated: Legacy = { ...legacyExecutable };
  const runnerTranslated: Legacy = { ...legacyExecutable };
  requireExplicitCompletionCriterion(userTranslated);
  requireExplicitCompletionCriterion(runnerTranslated);
  assert.deepEqual(userTranslated, runnerTranslated);
  assert.equal(userTranslated.completionCriterion, 'EXECUTABLE');

  assert.equal(serviceCalls, 0, 'a refused declaration must not reach the service at either door');
});

/** 0237 takes the default away; nothing is left to answer for a caller who declared nothing. */
suite('an insert with no completion criterion is refused rather than defaulted', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  t.after(async () => { await sql.end(); });
  await verifyCoordinatorPgIdentity(sql);

  const stored = await sql.query<{ column_default: string | null; is_nullable: string }>(
    `SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'task' AND column_name = 'completion_criterion'`,
  );
  assert.equal(stored.rowCount, 1, 'the column itself is not what 0237 removed');
  assert.equal(stored.rows[0].column_default, null, '0237 drops the default outright');
  assert.equal(stored.rows[0].is_nullable, 'NO', 'and leaves the column NOT NULL');

  // In one transaction that is rolled back: this asserts what the schema refuses, and has no
  // business leaving a user or a task behind to prove it.
  const ownerId = randomUUID();
  await sql.query('BEGIN');
  try {
    await sql.query(
      `INSERT INTO "user" ("id", "email", "name", "password_hash")
       VALUES ($1, $2, 'n1', 'x')`, [ownerId, `${ownerId}@n1-0237.invalid`],
    );
    const insert = (columns: string, values: string, params: unknown[]) => sql.query(
      `INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id", "updated_at"${columns})
       VALUES ($1, 'undeclared', $2, 'USER', $2, now()${values})`, params,
    );
    await sql.query('SAVEPOINT probe');
    const refused = await insert('', '', [randomUUID(), ownerId]).then(
      () => '', (error: Error) => error.message,
    );
    assert.match(refused, /null value in column "completion_criterion"/,
      'omitting the column must raise NOT NULL, not pick a criterion');
    await sql.query('ROLLBACK TO SAVEPOINT probe');
    // The same insert naming the criterion still works, so what failed above is the absent default
    // and not the statement.
    const accepted = await insert(
      ', "completion_criterion"', ", 'EVIDENCE_JUDGMENT'::\"task_completion_criterion\"",
      [randomUUID(), ownerId],
    );
    assert.equal(accepted.rowCount, 1);
  } finally {
    await sql.query('ROLLBACK');
  }

  // Rows written before 0237 keep the value they had: the migration drops a default, and a default
  // is only ever read by an INSERT, so there is nothing for it to rewrite.
  const migration = readFileSync(join(
    process.cwd(), 'prisma', 'migrations',
    '0237_task_completion_criterion_explicit_declaration', 'migration.sql',
  ), 'utf8');
  assert.match(migration, /ALTER TABLE "task" ALTER COLUMN "completion_criterion" DROP DEFAULT/);
  const statements = migration.replace(/^--.*$/gm, '');
  assert.doesNotMatch(statements, /UPDATE\s+"?task"?/i, 'existing rows are the facts of their time');
  assert.doesNotMatch(statements, /SET\s+DEFAULT/i);
});

/**
 * The fabrication form, counted rather than described.
 *
 * A nullish-coalescing fallback into EVIDENCE_JUDGMENT read as a safety net and acted as a forgery:
 * each one answered a caller who had declared nothing, and answered with the single criterion that
 * nothing can satisfy. There were six. 0233 and 0234 took the three on the project-criterion side
 * away with the wiring they belonged to, and this change removes the last three. Zero is asserted
 * over the whole source tree rather than over the three files that happened to hold them, because
 * the next one will be written somewhere else.
 *
 * The pattern is assembled at run time and never spelled out in one piece anywhere in this file. A
 * scan that reads every source file reads this one too, so a literal example here would be an
 * offender — and exempting the scanner's own file is how a scanner stops seeing things.
 */
test('no source file fabricates a criterion by coalescing into EVIDENCE_JUDGMENT', () => {
  const coalesce = '?'.repeat(2);
  const fabrication = new RegExp(`\\?\\?\\s*'EVIDENCE_JUDGMENT'`);
  const root = join(__dirname, '..', '..', '..', '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Dependencies and build output are not this repository's code, and a symlinked node_modules
      // is not reported as a directory at all — name them anyway, so a real one cannot be walked.
      if (['node_modules', 'build', 'dist', '.git'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
        // Only the fallback. `completionCriterion: 'EVIDENCE_JUDGMENT'` is a DECLARATION, which is
        // exactly what this change asks every caller and every fixture for.
        if (fabrication.test(line)) offenders.push(`${full.slice(root.length + 1)}:${index + 1}`);
      });
    }
  };
  walk(root);
  assert.deepEqual(offenders, [],
    `a criterion may not be invented for a caller: ${offenders.join(', ')}`);

  // The scan is answerable for being able to see one at all, and for having read a real tree.
  assert.match(
    `const criterion = facts.completionCriterion ${coalesce} 'EVIDENCE_JUDGMENT';`, fabrication,
  );
  assert.doesNotMatch(`completionCriterion: 'EVIDENCE_JUDGMENT',`, fabrication);
  assert.ok(readFileSync(join(root, 'apiserver/src/tasks/task-completion-criterion.ts'), 'utf8')
    .includes('export function evaluateTaskCompletion'), 'the scan root is the source tree');
});
